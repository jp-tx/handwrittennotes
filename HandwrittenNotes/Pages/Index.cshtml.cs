using HandwrittenNotes.Services;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;

namespace HandwrittenNotes.Pages;

public class IndexModel : PageModel
{
    private readonly NotebookService _svc;

    public IndexModel(NotebookService svc) => _svc = svc;

    public async Task<IActionResult> OnGetAsync()
    {
        var index = await _svc.ReadIndexAsync();
        var first = index.Notebooks.FirstOrDefault();
        if (first is null) return Page();
        var page = first.Pages.FirstOrDefault();
        if (page is null) return Page();
        return Redirect($"/notebooks/{first.Id}/pages/{page.Id}");
    }
}
