using HandwrittenNotes.Services;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;

namespace HandwrittenNotes.Pages;

public class IndexModel : PageModel
{
    private readonly NotebookService _svc;

    public IndexModel(NotebookService svc) => _svc = svc;

    public IActionResult OnGet() => Page();
}
