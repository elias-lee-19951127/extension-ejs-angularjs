plugins {
    // Cho phep Gradle tu tai JDK dung phien ban cho toolchain.
    // Nho vay teammate chi can mot JDK bat ky de chay Gradle, khong phai
    // cai dung JDK 21 bang tay.
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
}

rootProject.name = "ejsng-intellij"
