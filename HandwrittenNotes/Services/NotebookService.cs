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
        var path = Path.Combine(_dataPath, $"{pageId}.{type}");
        return File.Exists(path) ? await File.ReadAllBytesAsync(path) : null;
    }

    public async Task WritePageContentAsync(string pageId, string type, byte[] content)
    {
        await File.WriteAllBytesAsync(Path.Combine(_dataPath, $"{pageId}.{type}"), content);
    }

    public void DeletePageFile(string pageId, string type)
    {
        var path = Path.Combine(_dataPath, $"{pageId}.{type}");
        if (File.Exists(path)) File.Delete(path);
    }
}
