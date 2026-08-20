// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "QuotaPie",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "QuotaPie", targets: ["QuotaPie"]),
    ],
    targets: [
        .executableTarget(
            name: "QuotaPie",
            path: "macos/QuotaPie",
            exclude: ["Info.plist"]
        ),
    ],
    swiftLanguageVersions: [.v5]
)
