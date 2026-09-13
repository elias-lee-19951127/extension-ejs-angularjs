package com.ejsng.intellij

import com.intellij.openapi.project.Project
import com.redhat.devtools.lsp4ij.server.ProcessStreamConnectionProvider
import java.io.File

/**
 * Locate Node and the server file, then run `node <server>/dist/index.js --stdio`.
 *
 * Server lookup order:
 *   1. the EJSNG_SERVER_PATH environment variable  (used during development)
 *   2. the server bundled with the plugin           (released build)
 *   3. the project's own node_modules               (when working inside the monorepo)
 */
class EjsNgServerConnection(private val project: Project) : ProcessStreamConnectionProvider() {

    init {
        val node = NodeLocator.find()
        val server = findServer()
        commands = listOf(node, server.absolutePath, "--stdio")
        workingDirectory = project.basePath
    }

    private fun findServer(): File {
        System.getenv("EJSNG_SERVER_PATH")?.let { path ->
            val f = File(path)
            if (f.isFile) return f
        }

        val bundled = File(pluginDir(), "server/dist/index.js")
        if (bundled.isFile) return bundled

        val base = project.basePath ?: "."
        val local = File(base, "node_modules/@ejsng/server/dist/index.js")
        if (local.isFile) return local

        throw IllegalStateException(
            "ejs-ng-language-server not found. Set the EJSNG_SERVER_PATH environment variable " +
                "to point to packages/server/dist/index.js, or install @ejsng/server in the project."
        )
    }

    private fun pluginDir(): File =
        File(javaClass.protectionDomain.codeSource.location.toURI()).parentFile.parentFile
}
