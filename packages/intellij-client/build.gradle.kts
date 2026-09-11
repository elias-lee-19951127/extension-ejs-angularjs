plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "2.4.20"
    id("org.jetbrains.intellij.platform") version "2.18.1"
}

group = "com.ejsng"
version = "0.1.0"

repositories {
    mavenCentral()
    intellijPlatform { defaultRepositories() }
}

dependencies {
    intellijPlatform {
        // Dung ban Community lam muc tieu bien dich, va do la co y:
        // neu plugin bien dich va chay duoc tren Community thi no chay duoc
        // tren moi ban IDE. Nguoc lai thi khong.
        //
        // LSP4IJ chay duoc tren Community, khac voi API LSP san cua JetBrains
        // (com.intellij.platform.lsp) von chi co o IDE thuong mai.
        // Xem docs/kien-truc.md phu luc B.
        intellijIdeaCommunity("2024.2")
        plugin("com.redhat.devtools.lsp4ij:0.21.0")
    }
}

kotlin { jvmToolchain(21) }

intellijPlatform {
    // IntelliJ Plugin Verifier: kiem tra tinh moi API call cua plugin doi chieu
    // voi IDE that. Day la buoc duy nhat bat duoc loi "plugin cai duoc nhung
    // khong load" ma khong can mo GUI.
    pluginVerification {
        ides {
            // current() = chinh IDE dang duoc nham toi o tren (IDEA CE 2024.2),
            // da tai san nen khong phai tai them ban phan phoi nao.
            current()
        }
    }

    pluginConfiguration {
        ideaVersion {
            sinceBuild = "242"
            // Khong dat untilBuild: day la cong cu noi bo, khong muon plugin
            // tu vo hieu hoa moi lan team nang cap IDE.
            untilBuild = provider { null }
        }
    }
}

tasks {
    runIde {
        // Mo san repo that de LSP4IJ khoi dong server khi co file .js/.ejs.
        argumentProviders.add(
            CommandLineArgumentProvider { listOf("/Volumes/mac-dev/project/smart-city") }
        )
        // Tro toi language server dang phat trien trong monorepo nay.
        environment(
            "EJSNG_SERVER_PATH",
            "${project.rootDir}/../server/dist/index.js",
        )
    }
}
