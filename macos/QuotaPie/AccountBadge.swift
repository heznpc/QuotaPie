import AppKit

/// Local account identity: stable colour comes from the routing ID, while the
/// letter follows the user's nickname or account label.
struct AccountBadge {
    static let menuSize: CGFloat = 16
    static let menuSpacing: CGFloat = 4

    let accountID: String
    let name: String

    var initial: String {
        String(name.trimmingCharacters(in: .whitespacesAndNewlines).first.map(String.init) ?? "?").uppercased()
    }
    var color: NSColor {
        let hash = accountID.utf8.reduce(UInt32(2166136261)) { ($0 ^ UInt32($1)) &* 16777619 }
        return NSColor(calibratedHue: CGFloat(hash % 360) / 360, saturation: 0.30, brightness: 0.36, alpha: 1)
    }
    func draw(in rect: NSRect) {
        color.setFill()
        NSBezierPath(ovalIn: rect).fill()
        let text = NSAttributedString(string: initial, attributes: [
            .font: NSFont.systemFont(ofSize: rect.height * 0.56, weight: .medium),
            .foregroundColor: NSColor.white,
        ])
        text.draw(at: NSPoint(x: rect.midX - text.size().width / 2, y: rect.midY - text.size().height / 2))
    }
    func image(size: CGFloat = AccountBadge.menuSize) -> NSImage {
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
