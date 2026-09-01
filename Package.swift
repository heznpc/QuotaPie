// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "QuotaPie",
    defaultLocalization: "en",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "QuotaPie", targets: ["QuotaPie"]),
    ],
    targets: [
        .executableTarget(
            name: "QuotaPie",
            path: "macos/QuotaPie",
            exclude: ["Info.plist", "QuotaPie.entitlements", "QuotaPie.icns"],
            resources: [.process("Resources")]
        ),
        .testTarget(
            name: "QuotaPieTests",
            dependencies: ["QuotaPie"],
            path: "macos/QuotaPieTests"
        ),
    ],
    swiftLanguageVersions: [.v5]
)
