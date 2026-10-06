import AppKit

/// Local account identity: stable colour comes from the routing ID, while the
/// letter follows the user's nickname or account label.
struct AccountBadge {
    let accountID: String
    let name: String

    var initial: String {
        String(name.trimmingCharacters(in: .whitespacesAndNewlines).first.map(String.init) ?? "?").uppercased()
    }
    var color: NSColor {
        let hash = accountID.utf8.reduce(UInt32(2166136261)) { ($0 ^ UInt32($1)) &* 16777619 }
        return NSColor(calibratedHue: CGFloat(hash % 360) / 360, saturation: 0.66, brightness: 0.46, alpha: 1)
    }
    func draw(in rect: NSRect) {
        color.setFill()
        NSBezierPath(ovalIn: rect).fill()
        NSColor.white.withAlphaComponent(0.25).setStroke()
        let border = NSBezierPath(ovalIn: rect.insetBy(dx: 0.5, dy: 0.5))
        border.lineWidth = 0.5
        border.stroke()
        let text = NSAttributedString(string: initial, attributes: [
            .font: NSFont.systemFont(ofSize: rect.height * 0.58, weight: .semibold),
            .foregroundColor: NSColor.white,
        ])
        text.draw(at: NSPoint(x: rect.midX - text.size().width / 2, y: rect.midY - text.size().height / 2))
    }
    func image(size: CGFloat = 18) -> NSImage {
        let image = NSImage(size: NSSize(width: size, height: size), flipped: false) { _ in
            draw(in: NSRect(x: 0, y: 0, width: size, height: size)); return true
        }
        image.isTemplate = false
        return image
    }
}

/// The badge is decorative; clicks still belong to the status-bar button.
final class AccountBadgeImageView: NSImageView {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}
