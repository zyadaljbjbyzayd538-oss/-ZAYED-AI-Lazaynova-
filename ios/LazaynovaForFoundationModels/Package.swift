// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "LazaynovaForFoundationModels",
    platforms: [
        .iOS("27.0"),
        .macOS("27.0"),
    ],
    products: [
        .library(name: "LazaynovaForFoundationModels", targets: ["LazaynovaForFoundationModels"]),
    ],
    targets: [
        .target(name: "LazaynovaForFoundationModels"),
    ]
)
