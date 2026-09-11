package com.ejsng.intellij

import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import com.redhat.devtools.lsp4ij.LanguageServerManager

/**
 * Khoi dong language server ngay khi mo project, khong doi mo file dau tien.
 *
 * Mac dinh cua LSP4IJ la khoi dong luoi: server chi chay khi co file khop duoc
 * mo trong editor. Voi mot language server thong thuong thi hop ly, nhung server
 * nay phai DANH INDEX ca workspace truoc khi tra loi duoc cau hoi dau tien
 * (147 file mat khoang 200ms, repo lon hon thi lau hon).
 *
 * Khoi dong luoi nghia la lan Ctrl+Click dau tien cua nguoi dung phai cho ca
 * vong index. Khoi dong som thi viec do xay ra trong luc IDE con dang danh
 * index cua chinh no, luc nguoi dung chua thao tac gi.
 *
 * `forceStart = true` de server chay ngay ca khi chua co file nao mo.
 */
class EjsNgStartupActivity : ProjectActivity {

    override suspend fun execute(project: Project) {
        LOG.info("EJSNG: startup activity chay cho project '${project.name}'")
        runCatching {
            val manager = LanguageServerManager.getInstance(project)
            manager.start(
                SERVER_ID,
                LanguageServerManager.StartOptions()
                    .setForceStart(true)
                    .setWillEnable(true),
            )
            LOG.info("EJSNG: da yeu cau start '$SERVER_ID', trang thai=${manager.getServerStatus(SERVER_ID)}")
        }.onFailure {
            // Khong lam hong viec mo project chi vi server khong len duoc.
            LOG.warn("EJSNG: khong khoi dong duoc language server '$SERVER_ID'", it)
        }
    }

    companion object {
        /** Phai trung voi thuoc tinh id cua the <server> trong plugin.xml. */
        const val SERVER_ID = "ejsng"

        private val LOG = logger<EjsNgStartupActivity>()
    }
}
