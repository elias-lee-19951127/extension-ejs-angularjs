package com.ejsng.intellij

import java.io.File

/**
 * Tim runtime Node de chay language server.
 *
 * Vi sao can ca mot file cho viec nay: IDE khoi dong tu Dock/Finder KHONG ke thua
 * PATH cua shell dang nhap, nen `node` cai qua nvm/fnm/volta/asdf — cach cai pho
 * bien nhat trong doi ngu JavaScript — se khong nhin thay duoc. Chi quet vai
 * duong dan he thong la hong voi da so nguoi dung.
 */
object NodeLocator {

    fun find(): String =
        fromEnv()
            ?: fromVersionManagers()
            ?: fromSystemPaths()
            ?: fromLoginShell()
            ?: throw IllegalStateException(
                "Khong tim thay Node. Cai Node >= 18, hoac dat bien moi truong " +
                    "EJSNG_NODE tro toi file thuc thi node.",
            )

    private fun fromEnv(): String? =
        System.getenv("EJSNG_NODE")?.takeIf { File(it).canExecute() }

    /** nvm, fnm, volta, asdf, nodenv — chon ban cao nhat khi co nhieu ban. */
    private fun fromVersionManagers(): String? {
        val home = System.getProperty("user.home")

        // volta va asdf dung shim co dinh, khong can chon phien ban.
        listOf(
            "$home/.volta/bin/node",
            "$home/.asdf/shims/node",
        ).firstOrNull { File(it).canExecute() }?.let { return it }

        // nvm / fnm / nodenv: mot thu muc cho moi phien ban.
        val versionRoots = listOf(
            File("$home/.nvm/versions/node"),
            File("$home/.fnm/node-versions"),
            File("$home/Library/Application Support/fnm/node-versions"),
            File("$home/.nodenv/versions"),
        )

        return versionRoots
            .filter { it.isDirectory }
            .flatMap { it.listFiles()?.toList() ?: emptyList() }
            .mapNotNull { dir ->
                // nvm:  <ver>/bin/node        fnm: <ver>/installation/bin/node
                listOf(
                    File(dir, "bin/node"),
                    File(dir, "installation/bin/node"),
                ).firstOrNull { it.canExecute() }?.let { dir.name to it }
            }
            .maxWithOrNull(compareBy(VersionComparator) { it.first })
            ?.second
            ?.absolutePath
    }

    private fun fromSystemPaths(): String? =
        listOf(
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
            "/snap/bin/node",
        ).firstOrNull { File(it).canExecute() }

    /**
     * Cuoi cung: hoi chinh shell dang nhap cua nguoi dung.
     * Bat duoc cac cach cai la, doi lai ton mot lan sinh tien trinh.
     */
    private fun fromLoginShell(): String? = runCatching {
        val shell = System.getenv("SHELL") ?: "/bin/sh"
        val process = ProcessBuilder(shell, "-l", "-c", "command -v node")
            .redirectErrorStream(true)
            .start()
        val output = process.inputStream.bufferedReader().readText().trim()
        process.waitFor()
        output.lines().firstOrNull { File(it).canExecute() }
    }.getOrNull()

    /** So sanh "v20.20.0" / "20.20.0" theo tung so, khong theo thu tu chuoi. */
    private object VersionComparator : Comparator<String> {
        override fun compare(a: String, b: String): Int {
            val pa = parse(a)
            val pb = parse(b)
            for (i in 0 until maxOf(pa.size, pb.size)) {
                val diff = (pa.getOrNull(i) ?: 0) - (pb.getOrNull(i) ?: 0)
                if (diff != 0) return diff
            }
            return 0
        }

        private fun parse(v: String): List<Int> =
            v.removePrefix("v").split('.').map { it.takeWhile(Char::isDigit).toIntOrNull() ?: 0 }
    }
}
