import AppKit

/// A template image lets the menu bar choose the foreground for its wallpaper,
/// appearance, and highlighted state. The fill always means remaining quota.
enum MenuBarQuotaIndicator {
    static func image(label: String, remainingPercent: Double) -> NSImage {
        let remaining = min(100, max(0, remainingPercent))
        let labelAttributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 12, weight: .medium),
            .foregroundColor: NSColor.black,
        ]
        let numberAttributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium),
            .foregroundColor: NSColor.black,
        ]
        let labelText = NSAttributedString(string: label, attributes: labelAttributes)
        let numberText = NSAttributedString(
            string: "\(Int(remaining.rounded()))%", attributes: numberAttributes
        )
        // Reserve room for 100% so updates do not shift adjacent menu items.
        let numberWidth = ceil(NSAttributedString(string: "100%", attributes: numberAttributes).size().width)
        let labelWidth = ceil(labelText.size().width)
        let batteryX = labelWidth + 6
        let numberX = batteryX + 30 + 5
        let size = NSSize(width: numberX + numberWidth, height: 18)
        let image = NSImage(size: size, flipped: false) { _ in
            labelText.draw(at: NSPoint(x: 0, y: floor((size.height - labelText.size().height) / 2)))
            numberText.draw(at: NSPoint(
                x: numberX + numberWidth - ceil(numberText.size().width),
                y: floor((size.height - numberText.size().height) / 2)
            ))

            let body = NSRect(x: batteryX + 0.5, y: 3.5, width: 26, height: 11)
            let outline = NSBezierPath(roundedRect: body, xRadius: 2.5, yRadius: 2.5)
            outline.lineWidth = 1
            NSColor.black.withAlphaComponent(0.55).setStroke()
            outline.stroke()
            NSColor.black.withAlphaComponent(0.55).setFill()
            NSBezierPath(
                roundedRect: NSRect(x: batteryX + 28, y: 6.5, width: 2, height: 5),
                xRadius: 1, yRadius: 1
            ).fill()

            let interior = body.insetBy(dx: 2, dy: 2)
            if remaining > 0 {
                NSGraphicsContext.saveGraphicsState()
                NSBezierPath(roundedRect: interior, xRadius: 1, yRadius: 1).addClip()
                NSColor.black.setFill()
                NSRect(
                    x: interior.minX, y: interior.minY,
                    width: interior.width * remaining / 100, height: interior.height
                ).fill()
                NSGraphicsContext.restoreGraphicsState()
            }
            return true
        }
        image.isTemplate = true
        return image
    }
}
