// cocoa-capture <pid> <seconds> <out>
//
// What reaches the screen, for ./e2p.tsx: the first on-screen window of
// process <pid>, streamed through ScreenCaptureKit at the display's rate,
// one line per frame whose content changed —
//
//   <display time, ns> <minX> <maxX> <count>
//
// — the frame's display time on mach_continuous_time (the clock Node's
// process.hrtime.bigint() reads), and the horizontal extent and the number
// of the pixels of the marker colour, #ff00ff, in the frame's own pixels
// (every other row). A window snapshot from inside the app would wait on the
// loop that draws; this runs beside it, and the display time is the window
// server's, so no frame is timed by when it was read.
//
// Prints "ready <width>x<height>" once the stream runs. DUMP=<path> writes
// the fortieth changed frame as a PNG, to see what the stream sees.
//
// Needs Screen Recording for whatever runs it (a terminal, the IDE), and
// asks CGPreflightScreenCaptureAccess() first, which answers without the
// system's prompt: without it this says so and exits 5 rather than raising
// a dialog in the middle of a sweep. ./e2p.tsx builds it with swiftc on first
// use.
import AppKit
import CoreImage
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit

// a connection to the window server, which NSScreen and the stream need —
// a command-line tool has none until something asks — and no Dock icon
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

guard CGPreflightScreenCaptureAccess() else {
  FileHandle.standardError.write(
    "no Screen Recording for this terminal: System Settings, Privacy & Security, Screen Recording\n"
      .data(using: .utf8)!)
  exit(5)
}

let args = CommandLine.arguments
guard args.count >= 4, let pid = Int32(args[1]), let seconds = Double(args[2]) else {
  FileHandle.standardError.write("usage: cocoa-capture <pid> <seconds> <out>\n".data(using: .utf8)!)
  exit(2)
}
let outPath = args[3]
FileManager.default.createFile(atPath: outPath, contents: nil)
let out = FileHandle(forWritingAtPath: outPath)!

var timebase = mach_timebase_info_data_t()
mach_timebase_info(&timebase)
// Display times are on mach_absolute_time, which stops while the machine
// sleeps; mach_continuous_time does not. They differ by a constant while it
// is awake, and a machine that has ever slept has them days apart.
let sleptTicks = mach_continuous_time() - mach_absolute_time()

final class Output: NSObject, SCStreamOutput, SCStreamDelegate {
  var lines = [String]()
  func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
    // a frame is `.complete` when its content changed, `.idle` when not
    guard type == .screen,
      let attachments = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false)
        as? [[SCStreamFrameInfo: Any]],
      let info = attachments.first,
      let raw = info[.status] as? Int,
      let status = SCFrameStatus(rawValue: raw), status == .complete,
      let pb = CMSampleBufferGetImageBuffer(sb)
    else { return }
    let display = (info[.displayTime] as? UInt64) ?? 0
    let ns = (display + sleptTicks) * UInt64(timebase.numer) / UInt64(timebase.denom)
    CVPixelBufferLockBaseAddress(pb, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
    let w = CVPixelBufferGetWidth(pb)
    let h = CVPixelBufferGetHeight(pb)
    let stride = CVPixelBufferGetBytesPerRow(pb)
    guard let base = CVPixelBufferGetBaseAddress(pb) else { return }
    let p = base.assumingMemoryBound(to: UInt8.self)
    var minX = Int.max, maxX = -1, count = 0
    var y = 0
    while y < h {
      let row = p + y * stride
      var x = 0
      while x < w {
        let o = x * 4
        // BGRA: #ff00ff comes out of the display's colour space near
        // B 247, G 51, R 234, not as written
        if row[o] > 200 && row[o + 1] < 100 && row[o + 2] > 200 {
          if x < minX { minX = x }
          if x > maxX { maxX = x }
          count += 1
        }
        x += 1
      }
      y += 2
    }
    lines.append("\(ns) \(count > 0 ? minX : -1) \(maxX) \(count)")
    if lines.count == 40, let dump = ProcessInfo.processInfo.environment["DUMP"] {
      let rep = NSCIImageRep(ciImage: CIImage(cvPixelBuffer: pb))
      let img = NSImage(size: rep.size)
      img.addRepresentation(rep)
      if let tiff = img.tiffRepresentation, let bmp = NSBitmapImageRep(data: tiff),
        let png = bmp.representation(using: .png, properties: [:])
      {
        try? png.write(to: URL(fileURLWithPath: dump))
      }
    }
  }
  func stream(_ stream: SCStream, didStopWithError error: Error) {
    FileHandle.standardError.write("stopped: \(error)\n".data(using: .utf8)!)
  }
}

let output = Output()

Task {
  do {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    guard
      let window = content.windows.first(where: {
        $0.owningApplication?.processID == pid && $0.frame.width > 100
      })
    else {
      FileHandle.standardError.write("no window for pid \(pid)\n".data(using: .utf8)!)
      exit(3)
    }
    let config = SCStreamConfiguration()
    let scale = NSScreen.main?.backingScaleFactor ?? 2
    config.width = Int(window.frame.width * scale)
    config.height = Int(window.frame.height * scale)
    config.minimumFrameInterval = CMTime(value: 1, timescale: 120)
    config.pixelFormat = kCVPixelFormatType_32BGRA
    config.queueDepth = 8
    config.showsCursor = false
    let stream = SCStream(
      filter: SCContentFilter(desktopIndependentWindow: window), configuration: config, delegate: output)
    try stream.addStreamOutput(
      output, type: .screen, sampleHandlerQueue: DispatchQueue(label: "frames", qos: .userInteractive))
    try await stream.startCapture()
    print("ready \(config.width)x\(config.height)")
    fflush(stdout)
    try await Task.sleep(nanoseconds: UInt64(seconds * 1e9))
    try await stream.stopCapture()
    out.write(output.lines.joined(separator: "\n").data(using: .utf8)!)
    out.closeFile()
    exit(0)
  } catch {
    FileHandle.standardError.write("error: \(error)\n".data(using: .utf8)!)
    exit(4)
  }
}
RunLoop.main.run()
