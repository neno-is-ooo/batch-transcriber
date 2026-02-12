// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "parakeet-batch-worker",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(
            name: "parakeet-batch",
            targets: ["parakeet-batch"]
        ),
        .executable(
            name: "parakeet-modelctl",
            targets: ["parakeet-modelctl"]
        )
    ],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", from: "0.7.9")
    ],
    targets: [
        .executableTarget(
            name: "parakeet-batch",
            dependencies: [
                .product(name: "FluidAudio", package: "FluidAudio")
            ]
        ),
        .executableTarget(
            name: "parakeet-modelctl",
            dependencies: [
                .product(name: "FluidAudio", package: "FluidAudio")
            ]
        ),
        .testTarget(
            name: "parakeet-batchTests"
        )
    ]
)
