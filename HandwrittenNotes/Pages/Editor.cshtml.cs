using HandwrittenNotes.Services;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;

namespace HandwrittenNotes.Pages;

public class EditorModel : PageModel
{
    private readonly NotebookService _svc;

    public EditorModel(NotebookService svc) => _svc = svc;

    public string NotebookId { get; private set; } = "";
    public string PageId { get; private set; } = "";
    public string PageName { get; private set; } = "";
    public string PageType { get; private set; } = "txt";
    public string? Style { get; private set; }
    public int CanvasWidth { get; private set; } = 1920;
    public int CanvasHeight { get; private set; } = 1080;

    public async Task<IActionResult> OnGetAsync(string notebookId, string pageId)
    {
        var index = await _svc.ReadIndexAsync();
        var nb = index.Notebooks.FirstOrDefault(n => n.Id == notebookId);
        if (nb is null) return NotFound();
        var page = nb.Pages.FirstOrDefault(p => p.Id == pageId);
        if (page is null) return NotFound();

        NotebookId = notebookId;
        PageId = pageId;
        PageName = page.Name;
        PageType = page.Type;
        Style = page.Style;
        CanvasWidth = page.CanvasWidth ?? index.Settings.DefaultCanvasWidth;
        CanvasHeight = page.CanvasHeight ?? index.Settings.DefaultCanvasHeight;

        return Page();
    }
}
