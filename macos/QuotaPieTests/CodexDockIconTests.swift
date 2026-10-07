import XCTest
@testable import QuotaPie

final class CodexDockIconTests: XCTestCase {
    func testLegacyChatGPTUsesNativeDefaultWithoutOfferingBundleModification() {
        XCTAssertEqual(CodexDockIcon.chatGPT.supportedChoice, .appDefault)
        XCTAssertEqual(CodexDockIcon.allCases, [.appDefault, .codex, .space])
        XCTAssertEqual(CodexDockIcon.chatGPT.nativeValue, "app-default")
        XCTAssertEqual(CodexDockIcon.codex.nativeValue, "codex-system")
        XCTAssertEqual(CodexDockIcon.space.nativeValue, "space-system")
    }

    func testExistingProfilesDecodeWithoutChangingTheirIcon() throws {
        let data = Data(#"[{"id":"primary","name":"Main","codexHome":"/tmp/main-home","appData":"/tmp/main-data"}]"#.utf8)
        let profiles = try JSONDecoder().decode([CodexDesktopProfile].self, from: data)
        XCTAssertNil(profiles[0].dockIcon)
    }

    func testEachProfileKeepsItsOwnIconAcrossReloads() throws {
        let name = "quotapie-icon-test-" + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let model = CodexProfilesModel(defaults: defaults)
        model.add(name: "Second", home: "/tmp/qp-second-home", data: "/tmp/qp-second-data")
        model.rememberDockIcon(.codex, for: model.profiles[0])
        model.rememberDockIcon(.chatGPT, for: model.profiles[1])
        let restored = CodexProfilesModel(defaults: defaults)
        XCTAssertEqual(restored.profiles.map(\.dockIcon), [.codex, .chatGPT])
        XCTAssertEqual(restored.profiles.map(\.codexHome), model.profiles.map(\.codexHome))
    }
}
