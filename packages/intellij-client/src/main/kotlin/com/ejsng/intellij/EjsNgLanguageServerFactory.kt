package com.ejsng.intellij

import com.intellij.openapi.project.Project
import com.redhat.devtools.lsp4ij.LanguageServerFactory
import com.redhat.devtools.lsp4ij.server.StreamConnectionProvider

/**
 * Cau noi IntelliJ <-> ejs-ng-language-server.
 *
 * Client o day co MOT nhiem vu: khoi dong server Node va noi stdio.
 * Toan bo logic phan giai nam trong @ejsng/core, dung chung voi VSCode —
 * ly do chinh chon kien truc LSP (docs/kien-truc.md muc 1).
 */
class EjsNgLanguageServerFactory : LanguageServerFactory {
    override fun createConnectionProvider(project: Project): StreamConnectionProvider =
        EjsNgServerConnection(project)
}
