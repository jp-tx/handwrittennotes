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

    var type  = req.Type.ToLower() == "bmp" ? "bmp" : "txt";
    var style = req.Style ?? "default";

    int cw, ch;
    if (style.StartsWith("lined-"))
    {
        cw = 1654; ch = 2339; // A4 portrait @ 200 DPI for all lined styles
    }
    else if (style != "default" && style.Contains('x'))
    {
        var parts = style.Split('x');
        cw = int.TryParse(parts[0], out var sw) ? sw : index.Settings.DefaultCanvasWidth;
        ch = int.TryParse(parts[1], out var sh) ? sh : index.Settings.DefaultCanvasHeight;
    }
    else
    {
        cw = req.CanvasWidth  ?? index.Settings.DefaultCanvasWidth;
        ch = req.CanvasHeight ?? index.Settings.DefaultCanvasHeight;
    }

    var page = new NotebookPage
    {
        Name         = req.Name,
        Type         = type,
        Style        = type == "bmp" ? style : null,
        CanvasWidth  = type == "bmp" ? cw : null,
        CanvasHeight = type == "bmp" ? ch : null
    };

    if (type == "txt")
    {
        await svc.WritePageContentAsync(page.Id, "txt", Encoding.UTF8.GetBytes(""));
    }
    // Lined BMP pages: no pre-generated file — lines are drawn client-side in JS at open time.
    // The BMP file is created on the user's first save and contains only their ink (no baked-in lines).

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
    var mime = type == "bmp" ? "image/png" : "text/plain; charset=utf-8";
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
record CreatePageRequest(string Name, string Type, string? Style, int? CanvasWidth, int? CanvasHeight);
record RenameRequest(string Name);

static class BmpUtils
{
    // Generates a 24-bit uncompressed top-down BMP with a white background,
    // evenly-spaced light-blue horizontal lines, and a red left-margin line.
    public static byte[] GenerateLined(int w, int h, int lineSpacing)
    {
        const int topMargin   = 40;   // px before first rule line
        const int leftMarginX = 200;  // x position of red margin line

        int rowSize     = ((w * 3 + 3) / 4) * 4;  // pad each row to 4 bytes
        int pixDataSize = rowSize * h;
        int fileSize    = 54 + pixDataSize;

        var buf = new byte[fileSize];  // zero-initialised (padding bytes correct)

        // File header
        buf[0] = 0x42; buf[1] = 0x4D;
        WriteI32(buf,  2, fileSize);
        WriteI32(buf, 10, 54);

        // BITMAPINFOHEADER
        WriteI32(buf, 14, 40);
        WriteI32(buf, 18, w);
        WriteI32(buf, 22, -h);   // negative height → top-down row order
        buf[26] = 1; buf[28] = 24;
        WriteI32(buf, 34, pixDataSize);
        WriteI32(buf, 38, 2835);  // ~72 DPI
        WriteI32(buf, 42, 2835);

        for (int y = 0; y < h; y++)
        {
            bool isRule = y >= topMargin && (y - topMargin) % lineSpacing == 0;
            int rowOff  = 54 + y * rowSize;

            for (int x = 0; x < w; x++)
            {
                int p = rowOff + x * 3;
                if (isRule)
                {
                    // Light blue #B0C4DE  →  BGR: 222, 196, 176
                    buf[p] = 222; buf[p+1] = 196; buf[p+2] = 176;
                }
                else if (x == leftMarginX)
                {
                    // Soft red  #FF9999  →  BGR: 153, 153, 255
                    buf[p] = 153; buf[p+1] = 153; buf[p+2] = 255;
                }
                else
                {
                    buf[p] = 255; buf[p+1] = 255; buf[p+2] = 255;  // white
                }
            }
        }

        return buf;
    }

    private static void WriteI32(byte[] buf, int off, int val)
    {
        buf[off]   = (byte) val;
        buf[off+1] = (byte)(val >>  8);
        buf[off+2] = (byte)(val >> 16);
        buf[off+3] = (byte)(val >> 24);
    }
}
