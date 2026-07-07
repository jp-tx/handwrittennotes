using System.Text.Json;
using HandwrittenNotes.Models;

namespace HandwrittenNotes.Services;

public class NotebookService
{
    private readonly string _dataPath;
    private readonly string _indexPath;
    private readonly SemaphoreSlim _lock = new(1, 1);
    private static readonly JsonSerializerOptions JsonOpts = new() { WriteIndented = true };

    public NotebookService(string dataPath)
    {
        _dataPath = dataPath;
        _indexPath = Path.Combine(dataPath, "_index.json");
        Directory.CreateDirectory(dataPath);
        if (!File.Exists(_indexPath))
            File.WriteAllText(_indexPath, JsonSerializer.Serialize(new AppIndex(), JsonOpts));
    }

    public async Task<AppIndex> ReadIndexAsync()
    {
        await _lock.WaitAsync();
        try
        {
            var json = await File.ReadAllTextAsync(_indexPath);
            return JsonSerializer.Deserialize<AppIndex>(json, JsonOpts) ?? new AppIndex();
        }
        finally { _lock.Release(); }
    }

    public async Task WriteIndexAsync(AppIndex index)
    {
        await _lock.WaitAsync();
        try
        {
            await File.WriteAllTextAsync(_indexPath, JsonSerializer.Serialize(index, JsonOpts));
        }
        finally { _lock.Release(); }
    }

    public async Task<byte[]?> ReadPageContentAsync(string pageId, string type)
    {
        if (type == "bmp")
        {
            // Prefer PNG (current format); fall back to BMP for pages saved before the format switch
            var pngPath = Path.Combine(_dataPath, $"{pageId}.png");
            if (File.Exists(pngPath)) return await File.ReadAllBytesAsync(pngPath);
            var bmpPath = Path.Combine(_dataPath, $"{pageId}.bmp");
            if (File.Exists(bmpPath)) return await File.ReadAllBytesAsync(bmpPath);
            return null;
        }
        var path = Path.Combine(_dataPath, $"{pageId}.{type}");
        return File.Exists(path) ? await File.ReadAllBytesAsync(path) : null;
    }

    public async Task WritePageContentAsync(string pageId, string type, byte[] content)
    {
        // Bitmap pages are stored as PNG regardless of the "bmp" type designator
        var ext  = type == "bmp" ? "png" : type;
        var path = Path.Combine(_dataPath, $"{pageId}.{ext}");
        await File.WriteAllBytesAsync(path, content);

        // Remove any legacy .bmp file so the two don't coexist
        if (type == "bmp")
        {
            var legacy = Path.Combine(_dataPath, $"{pageId}.bmp");
            if (File.Exists(legacy)) File.Delete(legacy);
        }
    }

    public void DeletePageFile(string pageId, string type)
    {
        if (type == "bmp")
        {
            var png = Path.Combine(_dataPath, $"{pageId}.png");
            if (File.Exists(png)) File.Delete(png);
        }
        var path = Path.Combine(_dataPath, $"{pageId}.{type}");
        if (File.Exists(path)) File.Delete(path);
    }
}
