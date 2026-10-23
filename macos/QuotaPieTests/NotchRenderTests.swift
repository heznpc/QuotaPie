import AppKit
import SwiftUI
import XCTest
@testable import QuotaPie

final class NotchRenderTests: XCTestCase {
    @MainActor
    func testLongAccountAndTransitionStayInsideMenuBarHeight() async throws {
        let model = PopoverModel()
        let json = #"{"accounts":[{"provider":"claude","account":"team","accountLabel":"A long company account label@example.com","enabled":true,"connection":"claude-desktop","desktopSessionFingerprint":"session-team","collection":{"health":"recent-success"},"windows":[{"provider":"claude","account":"team","bucket":"five_hour","label":"5h","windowSeconds":18000,"freshness":"fresh","observedAtMs":0,"remainingPercent":84}]}]}"#
        model.payload = try JSONDecoder().decode(StatusPayload.self, from: Data(json.utf8))
        model.followProvider(.claude)
        model.claudeSessionFingerprint = "session-team"
        let state = NotchViewState()
        state.snapshot = NotchSnapshot(model: model)
        state.placement = NotchPlacement.layout(screen: CGRect(x: 0, y: 0, width: 1470, height: 956), safeTop: 32,
            left: CGRect(x: 0, y: 924, width: 645.5, height: 32),
            right: CGRect(x: 824.5, y: 924, width: 645.5, height: 32))
        for event in [nil, Strings.t("notch.accountChanged")] as [String?] {
            state.event = event
            let renderer = ImageRenderer(content: NotchView(state: state, open: {}))
            renderer.scale = 2
            let image = try XCTUnwrap(renderer.cgImage)
            XCTAssertEqual(image.width, 758)
            XCTAssertEqual(image.height, 64)
            if event == nil, let path = ProcessInfo.processInfo.environment["QUOTAPIE_NOTCH_PREVIEW"] {
                let bitmap = NSBitmapImageRep(cgImage: image)
                try XCTUnwrap(bitmap.representation(using: .png, properties: [:])).write(to: URL(fileURLWithPath: path))
            }
        }
    }
}
