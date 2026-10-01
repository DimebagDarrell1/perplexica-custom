import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jsPDF } from 'jspdf';
import { loadTs } from '../helpers/loadTs.mjs';

const { default: UploadManager } = loadTs('src/lib/uploads/manager.ts');

for (const format of ['docx', 'pdf']) {
  test(`${format.toUpperCase()} extraction stores readable evidence with the upgraded dependencies`, async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'perplexica-document-test-'),
    );
    const originalDir = UploadManager.uploadsDir;
    const originalRecordPath = UploadManager.uploadedFilesRecordPath;
    UploadManager.uploadsDir = dir;
    UploadManager.uploadedFilesRecordPath = path.join(
      dir,
      'uploaded_files.json',
    );
    try {
      let buffer, mime;
      if (format === 'docx') {
        buffer = fs.readFileSync(
          new URL('../fixtures/document.docx', import.meta.url),
        );
        mime =
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      } else {
        const pdf = new jsPDF();
        pdf.text('PDF export and extraction regression', 10, 20);
        pdf.addPage();
        pdf.text('Second page evidence', 10, 20);
        buffer = Buffer.from(pdf.output('arraybuffer'));
        mime = 'application/pdf';
        assert.ok(buffer.subarray(0, 5).equals(Buffer.from('%PDF-')));
      }
      const embedded = [];
      const manager = new UploadManager({
        embeddingModel: {
          embedText: async (texts) => {
            embedded.push(...texts);
            return texts.map(() => [1, 0]);
          },
        },
      });
      const [file] = await manager.processFiles([
        new File([buffer], `document.${format}`, { type: mime }),
      ]);
      const text = UploadManager.getFileChunks(file.fileId)
        .map((chunk) => chunk.content)
        .join('\n');
      if (format === 'docx') {
        assert.match(text, /DOCX extraction regression/);
        assert.match(text, /Café costs \$12\.50/);
        assert.match(text, /Table evidence/);
      } else {
        assert.match(text, /PDF export and extraction regression/);
        assert.match(text, /Second page evidence/);
      }
      assert.equal(embedded.join('\n'), text);
    } finally {
      UploadManager.uploadsDir = originalDir;
      UploadManager.uploadedFilesRecordPath = originalRecordPath;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const fails of [false, true]) {
  test(`PDF resources close on ${fails ? 'parse failure' : 'success'} and uploads follow DATA_DIR`, async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'perplexica-pdf-cleanup-'),
    );
    const previous = process.env.DATA_DIR;
    process.env.DATA_DIR = directory;
    let destroyed = 0;
    try {
      const { default: Manager } = loadTs('src/lib/uploads/manager.ts', {
        'pdf-parse': {
          PDFParse: class {
            async getText() {
              if (fails) throw new Error('Invalid PDF fixture');
              return { text: 'Useful PDF evidence' };
            }
            async destroy() {
              destroyed++;
            }
          },
        },
        'pdf-parse/worker': { CanvasFactory: class {} },
      });
      assert.equal(Manager.uploadsDir, path.join(directory, 'data/uploads'));
      const manager = new Manager({
        embeddingModel: { embedText: async (texts) => texts.map(() => [1, 0]) },
      });
      const result = manager.processFiles([
        new File(['fixture'], 'fixture.pdf', { type: 'application/pdf' }),
      ]);
      if (fails) await assert.rejects(result, /Invalid PDF fixture/);
      else assert.equal((await result).length, 1);
      assert.equal(destroyed, 1);
    } finally {
      if (previous === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = previous;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
