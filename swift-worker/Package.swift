// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "coreml-batch-worker",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(
            name: "coreml-batch",
            targets: ["coreml-batch"]
        ),
        .executable(
            name: "coreml-modelctl",
            targets: ["coreml-modelctl"]
        )
    ],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", from: "0.7.9")
    ],
    targets: [
        .executableTarget(
            name: "coreml-batch",
            dependencies: [
                .product(name: "FluidAudio", package: "FluidAudio")
            ]
        ),
        .executableTarget(
            name: "coreml-modelctl",
            dependencies: [
                .product(name: "FluidAudio", package: "FluidAudio")
            ]
        ),
        .testTarget(
            name: "coreml-batchTests"
        )
    ]
)
