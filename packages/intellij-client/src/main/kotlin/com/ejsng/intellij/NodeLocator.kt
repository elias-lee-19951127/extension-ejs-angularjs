package com.ejsng.intellij

import java.io.File

/**
 * Find a Node runtime to run the language server.
 *
 * Why this needs its own file: the IDE launched from the Dock/Finder does NOT inherit the login
 * shell's PATH, so a `node` installed via nvm/fnm/volta/asdf — the most common installation
 * method among JavaScript teams — will not be visible. Scanning only a few system paths fails for
 * most users.
 */
object NodeLocator {

    fun find(): String =
        fromEnv()
            ?: fromVersionManagers()
            ?: fromSystemPaths()
            ?: fromLoginShell()
            ?: throw IllegalStateException(
                "Node not found. Install Node >= 18, or set the EJSNG_NODE environment " +
                    "variable to point to the node executable.",
            )

    private fun fromEnv(): String? =
        System.getenv("EJSNG_NODE")?.takeIf { File(it).canExecute() }

    /** nvm, fnm, volta, asdf, nodenv — pick the highest version when several are installed. */
    private fun fromVersionManagers(): String? {
        val home = System.getProperty("user.home")

        // volta and asdf use a fixed shim, no version selection needed.
        listOf(
            "$home/.volta/bin/node",
            "$home/.asdf/shims/node",
        ).firstOrNull { File(it).canExecute() }?.let { return it }

        // nvm / fnm / nodenv: one directory per version.
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
     * Last resort: ask the user's own login shell.
     * Catches unusual installation methods, at the cost of spawning one process.
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

    /** Compare "v20.20.0" / "20.20.0" numerically component by component, not as strings. */
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
