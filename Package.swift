// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "QuotaPie",
    defaultLocalization: "en",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "QuotaPie", targets: ["QuotaPie"]),
        .executable(name: "QuotaPiePowerHelper", targets: ["QuotaPiePowerHelper"]),
    ],
    targets: [
        .target(name: "PowerCore", path: "macos/PowerCore"),
        .executableTarget(name: "QuotaPiePowerHelper", dependencies: ["PowerCore"], path: "macos/QuotaPiePowerHelper"),
        .executableTarget(
            name: "QuotaPie",
            dependencies: ["PowerCore"],
            path: "macos/QuotaPie",
            exclude: ["Info.plist", "QuotaPie.entitlements", "QuotaPie.icns"],
            resources: [.process("Resources")]
        ),
        .testTarget(
            name: "QuotaPieTests",
            dependencies: ["QuotaPie", "PowerCore"],
            path: "macos/QuotaPieTests"
        ),
    ],
    swiftLanguageVersions: [.v5]
)
