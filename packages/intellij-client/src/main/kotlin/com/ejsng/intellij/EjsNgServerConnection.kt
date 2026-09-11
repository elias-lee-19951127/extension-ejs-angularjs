package com.ejsng.intellij

import com.intellij.openapi.project.Project
import com.redhat.devtools.lsp4ij.server.ProcessStreamConnectionProvider
import java.io.File

/**
 * Tim Node va file server, roi chay `node <server>/dist/index.js --stdio`.
 *
 * Thu tu tim server:
 *   1. bien moi truong EJSNG_SERVER_PATH  (dung khi phat trien)
 *   2. server dong goi kem plugin         (ban phat hanh)
 *   3. node_modules cua chinh du an       (khi lam viec trong monorepo)
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
            "Khong tim thay ejs-ng-language-server. Dat bien moi truong EJSNG_SERVER_PATH " +
                "tro toi packages/server/dist/index.js, hoac cai @ejsng/server vao du an."
        )
    }

    private fun pluginDir(): File =
        File(javaClass.protectionDomain.codeSource.location.toURI()).parentFile.parentFile
}
