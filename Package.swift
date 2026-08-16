// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "TimeQuotaMenu",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "TimeQuotaMenu", targets: ["TimeQuotaMenu"]),
    ],
    targets: [
        .executableTarget(
            name: "TimeQuotaMenu",
            path: "macos/TimeQuotaMenu",
            exclude: ["Info.plist"]
        ),
    ],
    swiftLanguageVersions: [.v5]
)
