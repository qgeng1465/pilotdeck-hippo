export function contentDispositionAttachment(filename) {
    const safeFilename = String(filename || 'download')
        .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
        .replace(/^\.+$/, 'download')
        .trim() || 'download';
    const asciiFilename = safeFilename.replace(/[^\x20-\x7e]/g, '_');
    return `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`;
}
