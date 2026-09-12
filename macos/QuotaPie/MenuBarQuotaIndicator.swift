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
        let barX = labelWidth + 6
        let barWidth: CGFloat = 36
        let numberX = barX + barWidth + 5
        let size = NSSize(width: numberX + numberWidth, height: 18)
        let image = NSImage(size: size, flipped: false) { _ in
            labelText.draw(at: NSPoint(x: 0, y: floor((size.height - labelText.size().height) / 2)))
            numberText.draw(at: NSPoint(
                x: numberX + numberWidth - ceil(numberText.size().width),
                y: floor((size.height - numberText.size().height) / 2)
            ))

            let track = NSRect(x: barX, y: 6, width: barWidth, height: 6)
            NSColor.black.withAlphaComponent(0.22).setFill()
            track.fill()
            if remaining > 0 {
                NSColor.black.setFill()
                NSRect(
                    x: track.minX, y: track.minY,
                    width: track.width * remaining / 100, height: track.height
                ).fill()
            }
            return true
        }
        image.isTemplate = true
        return image
    }
}
