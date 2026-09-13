package com.ejsng.intellij

import com.intellij.openapi.project.Project
import com.redhat.devtools.lsp4ij.LanguageServerFactory
import com.redhat.devtools.lsp4ij.server.StreamConnectionProvider

/**
 * Bridge between IntelliJ and ejs-ng-language-server.
 *
 * The client here has ONE job: start the Node server and connect over stdio.
 * All the resolution logic lives in @ejsng/core, shared with VSCode — the main
 * reason the LSP architecture was chosen (docs/kien-truc.md section 1).
 */
class EjsNgLanguageServerFactory : LanguageServerFactory {
    override fun createConnectionProvider(project: Project): StreamConnectionProvider =
        EjsNgServerConnection(project)
}
