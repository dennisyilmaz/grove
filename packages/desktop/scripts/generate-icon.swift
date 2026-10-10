// Grove app icon: macOS-style squircle (transparent margins, Apple icon grid),
// white field, link-blue lowercase "g", square black dot — the "g." wordmark.
// Run: swift packages/desktop/scripts/generate-icon.swift
// Then: pnpm --filter @grove/desktop exec tauri icon ./icon-source.png
import AppKit

let canvas = 1024
// Apple's icon grid: the visible squircle is ~824pt on a 1024pt canvas, with
// continuous corners ≈ 22.37% of the icon size. A rounded rect is close enough.
let iconSize: CGFloat = 824
let inset: CGFloat = (CGFloat(canvas) - iconSize) / 2
let cornerRadius: CGFloat = iconSize * 0.2237

guard let rep = NSBitmapImageRep(
  bitmapDataPlanes: nil,
  pixelsWide: canvas,
  pixelsHigh: canvas,
  bitsPerSample: 8,
  samplesPerPixel: 4,
  hasAlpha: true,
  isPlanar: false,
  colorSpaceName: .deviceRGB,
  bytesPerRow: 0,
  bitsPerPixel: 0
) else { fatalError("bitmap rep") }

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

// Squircle: white fill, whisper of a border so it survives light backgrounds.
let squircle = NSBezierPath(
  roundedRect: NSRect(x: inset, y: inset, width: iconSize, height: iconSize),
  xRadius: cornerRadius,
  yRadius: cornerRadius
)
NSColor.white.setFill()
squircle.fill()
NSColor(calibratedWhite: 0, alpha: 0.10).setStroke()
squircle.lineWidth = 3
squircle.stroke()

// The wordmark: SF lowercase g in classic link blue + square black dot on the baseline.
let linkBlue = NSColor(calibratedRed: 0, green: 0, blue: 0.933, alpha: 1) // #0000EE
let font = NSFont.systemFont(ofSize: 600, weight: .semibold)
let g = NSAttributedString(string: "g", attributes: [.font: font, .foregroundColor: linkBlue])
let gSize = g.size()

let dotSide: CGFloat = 104
let gap: CGFloat = 44
let totalWidth = gSize.width + gap + dotSide
let originX = (CGFloat(canvas) - totalWidth) / 2

// Vertically: center the visible glyph body (descender bottom → x-height top),
// not the full line box, so the mark sits optically centered in the squircle.
let baselineFromOrigin = abs(font.descender)
let visibleHeight = font.xHeight + baselineFromOrigin
let visibleBottomTarget = (CGFloat(canvas) - visibleHeight) / 2
let originY = visibleBottomTarget

g.draw(at: NSPoint(x: originX, y: originY))

// Optically the dot wants to share a bottom line with the g's descender —
// on the true baseline it reads as floating at Dock sizes.
let dotY = originY + baselineFromOrigin * 0.12
NSColor.black.setFill()
NSRect(x: originX + gSize.width + gap, y: dotY, width: dotSide, height: dotSide).fill()

NSGraphicsContext.restoreGraphicsState()

guard let png = rep.representation(using: .png, properties: [:]) else { fatalError("png") }
let out = URL(fileURLWithPath: CommandLine.arguments.count > 1
  ? CommandLine.arguments[1]
  : FileManager.default.currentDirectoryPath + "/icon-source.png")
try! png.write(to: out)
print("wrote \(out.path) (\(png.count) bytes)")
