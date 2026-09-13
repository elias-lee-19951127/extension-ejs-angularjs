package com.ejsng.intellij

import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import com.redhat.devtools.lsp4ij.LanguageServerManager

/**
 * Start the language server as soon as the project opens, without waiting for the first file to
 * be opened.
 *
 * LSP4IJ's default is lazy startup: the server only runs once a matching file is opened in the
 * editor. That is reasonable for a typical language server, but this server must INDEX the whole
 * workspace before it can answer the first question (147 files takes about 200ms; a larger repo
 * takes longer).
 *
 * Lazy startup means the user's first Ctrl+Click has to wait for the whole indexing round. Early
 * startup lets that happen while the IDE is still doing its own indexing, before the user has done
 * anything yet.
 *
 * `forceStart = true` so the server runs even when no file has been opened yet.
 */
class EjsNgStartupActivity : ProjectActivity {

    override suspend fun execute(project: Project) {
        LOG.info("EJSNG: startup activity running for project '${project.name}'")
        runCatching {
            val manager = LanguageServerManager.getInstance(project)
            manager.start(
                SERVER_ID,
                LanguageServerManager.StartOptions()
                    .setForceStart(true)
                    .setWillEnable(true),
            )
            LOG.info("EJSNG: requested start of '$SERVER_ID', status=${manager.getServerStatus(SERVER_ID)}")
        }.onFailure {
            // Don't break project opening just because the server failed to start.
            LOG.warn("EJSNG: failed to start language server '$SERVER_ID'", it)
        }
    }

    companion object {
        /** Must match the id attribute of the <server> tag in plugin.xml. */
        const val SERVER_ID = "ejsng"

        private val LOG = logger<EjsNgStartupActivity>()
    }
}
