using System.Security.Claims;
using System.Text;
using HandwrittenNotes.Models;
using HandwrittenNotes.Services;
using Microsoft.AspNetCore.Authentication;

var dataPath = Environment.GetEnvironmentVariable("DATA_PATH")
    ?? Path.Combine(Directory.GetCurrentDirectory(), "data");
var appPassword = Environment.GetEnvironmentVariable("APP_PASSWORD") ?? "password";

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRazorPages(options =>
{
    options.Conventions.AuthorizeFolder("/");
    options.Conventions.AllowAnonymousToPage("/Login");
});

builder.Services.AddSingleton(_ => new NotebookService(dataPath));

builder.Services.AddAuthentication("Cookies")
    .AddCookie("Cookies", options =>
    {
        options.LoginPath = "/Login";
        options.ExpireTimeSpan = TimeSpan.FromDays(30);
        options.SlidingExpiration = true;
    });
builder.Services.AddAuthorization();

var app = builder.Build();

app.UseStaticFiles();
app.UseAuthentication();
app.UseAuthorization();
app.MapRazorPages();

// ── Auth ────────────────────────────────────────────────────────────────────
app.MapPost("/api/auth/login", async (HttpContext ctx, LoginRequest req) =>
{
    if (req.Password != appPassword)
        return Results.Json(new { error = "Invalid password" }, statusCode: 401);

    var claims = new[] { new Claim(ClaimTypes.Name, "user") };
    var identity = new ClaimsIdentity(claims, "Cookies");
    var principal = new ClaimsPrincipal(identity);
    await ctx.SignInAsync("Cookies", principal, new AuthenticationProperties
    {
        IsPersistent = true,
        ExpiresUtc = DateTimeOffset.UtcNow.AddDays(30)
    });
    return Results.Ok();
});

app.MapPost("/api/auth/logout", async (HttpContext ctx) =>
{
    await ctx.SignOutAsync("Cookies");
    return Results.Ok();
}).RequireAuthorization();

// ── Sidebar ─────────────────────────────────────────────────────────────────
app.MapGet("/api/sidebar", async (NotebookService svc) =>
{
    var index = await svc.ReadIndexAsync();
    return Results.Ok(index.Notebooks);
}).RequireAuthorization();

// ── Notebooks ────────────────────────────────────────────────────────────────
var api = app.MapGroup("/api").RequireAuthorization();

api.MapGet("/notebooks", async (NotebookService svc) =>
{
    var index = await svc.ReadIndexAsync();
    return Results.Ok(index.Notebooks.Select(n => new { n.Id, n.Name, PageCount = n.Pages.Count }));
});

api.MapPost("/notebooks", async (NotebookService svc, CreateNotebookRequest req) =>
{
    var index = await svc.ReadIndexAsync();
    var nb = new Notebook { Name = req.Name };
    index.Notebooks.Add(nb);
    await svc.WriteIndexAsync(index);
    return Results.Ok(nb);
});

api.MapPatch("/notebooks/{id}", async (NotebookService svc, string id, RenameRequest req) =>
{
    var index = await svc.ReadIndexAsync();
    var nb = index.Notebooks.FirstOrDefault(n => n.Id == id);
    if (nb is null) return Results.NotFound();
    nb.Name = req.Name;
    await svc.WriteIndexAsync(index);
    return Results.Ok(nb);
});

api.MapDelete("/notebooks/{id}", async (NotebookService svc, string id) =>
{
    var index = await svc.ReadIndexAsync();
    var nb = index.Notebooks.FirstOrDefault(n => n.Id == id);
    if (nb is null) return Results.NotFound();
    foreach (var p in nb.Pages) svc.DeletePageFile(p.Id, p.Type);
    index.Notebooks.Remove(nb);
    await svc.WriteIndexAsync(index);
    return Results.Ok();
});

// ── Pages ────────────────────────────────────────────────────────────────────
api.MapGet("/notebooks/{notebookId}/pages", async (NotebookService svc, string notebookId) =>
{
    var index = await svc.ReadIndexAsync();
    var nb = index.Notebooks.FirstOrDefault(n => n.Id == notebookId);
    return nb is null ? Results.NotFound() : Results.Ok(nb.Pages);
});

api.MapPost("/notebooks/{notebookId}/pages", async (NotebookService svc, string notebookId, CreatePageRequest req) =>
{
    var index = await svc.ReadIndexAsync();
    var nb = index.Notebooks.FirstOrDefault(n => n.Id == notebookId);
    if (nb is null) return Results.NotFound();

    var type = req.Type.ToLower() == "bmp" ? "bmp" : "txt";
    var page = new NotebookPage
    {
        Name = req.Name,
        Type = type,
        CanvasWidth  = type == "bmp" ? (req.CanvasWidth  ?? index.Settings.DefaultCanvasWidth)  : null,
        CanvasHeight = type == "bmp" ? (req.CanvasHeight ?? index.Settings.DefaultCanvasHeight) : null
    };

    if (type == "txt")
        await svc.WritePageContentAsync(page.Id, "txt", Encoding.UTF8.GetBytes(""));

    nb.Pages.Add(page);
    await svc.WriteIndexAsync(index);
    return Results.Ok(page);
});

api.MapPatch("/notebooks/{notebookId}/pages/{pageId}", async (NotebookService svc, string notebookId, string pageId, RenameRequest req) =>
{
    var index = await svc.ReadIndexAsync();
    var nb = index.Notebooks.FirstOrDefault(n => n.Id == notebookId);
    if (nb is null) return Results.NotFound();
    var page = nb.Pages.FirstOrDefault(p => p.Id == pageId);
    if (page is null) return Results.NotFound();
    page.Name = req.Name;
    await svc.WriteIndexAsync(index);
    return Results.Ok(page);
});

api.MapDelete("/notebooks/{notebookId}/pages/{pageId}", async (NotebookService svc, string notebookId, string pageId) =>
{
    var index = await svc.ReadIndexAsync();
    var nb = index.Notebooks.FirstOrDefault(n => n.Id == notebookId);
    if (nb is null) return Results.NotFound();
    var page = nb.Pages.FirstOrDefault(p => p.Id == pageId);
    if (page is null) return Results.NotFound();
    svc.DeletePageFile(page.Id, page.Type);
    nb.Pages.Remove(page);
    await svc.WriteIndexAsync(index);
    return Results.Ok();
});

// ── Content ──────────────────────────────────────────────────────────────────
api.MapGet("/pages/{pageId}/content", async (NotebookService svc, string pageId, string type) =>
{
    var content = await svc.ReadPageContentAsync(pageId, type);
    if (content is null) return Results.NotFound();
    var mime = type == "bmp" ? "image/bmp" : "text/plain; charset=utf-8";
    return Results.File(content, mime);
});

api.MapPut("/pages/{pageId}/content", async (NotebookService svc, string pageId, string type, HttpRequest request) =>
{
    using var ms = new MemoryStream();
    await request.Body.CopyToAsync(ms);
    await svc.WritePageContentAsync(pageId, type, ms.ToArray());
    return Results.Ok();
});

// ── Settings ─────────────────────────────────────────────────────────────────
api.MapGet("/settings", async (NotebookService svc) =>
{
    var index = await svc.ReadIndexAsync();
    return Results.Ok(index.Settings);
});

api.MapPut("/settings", async (NotebookService svc, AppSettings settings) =>
{
    var index = await svc.ReadIndexAsync();
    index.Settings = settings;
    await svc.WriteIndexAsync(index);
    return Results.Ok(index.Settings);
});

app.Run();

record LoginRequest(string Password);
record CreateNotebookRequest(string Name);
record CreatePageRequest(string Name, string Type, int? CanvasWidth, int? CanvasHeight);
record RenameRequest(string Name);
