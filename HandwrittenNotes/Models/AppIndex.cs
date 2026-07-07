namespace HandwrittenNotes.Models;

public class AppIndex
{
    public AppSettings Settings { get; set; } = new();
    public List<Notebook> Notebooks { get; set; } = [];
}

public class AppSettings
{
    public int DefaultCanvasWidth { get; set; } = 1920;
    public int DefaultCanvasHeight { get; set; } = 1080;
    public int SessionDays { get; set; } = 30;
}

public class Notebook
{
    public string Id { get; set; } = Guid.NewGuid().ToString();
    public string Name { get; set; } = "Untitled";
    public List<NotebookPage> Pages { get; set; } = [];
}

public class NotebookPage
{
    public string Id { get; set; } = Guid.NewGuid().ToString();
    public string Name { get; set; } = "Untitled";
    public string Type { get; set; } = "txt";
    public string? Style { get; set; }
    public int? CanvasWidth { get; set; }
    public int? CanvasHeight { get; set; }
}
