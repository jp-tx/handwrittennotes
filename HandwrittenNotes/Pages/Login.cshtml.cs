using System.Security.Claims;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;

namespace HandwrittenNotes.Pages;

[AllowAnonymous]
public class LoginModel : PageModel
{
    private readonly string _password;

    public LoginModel(IConfiguration config)
    {
        _password = Environment.GetEnvironmentVariable("APP_PASSWORD") ?? "password";
    }

    public string? Error { get; private set; }

    public void OnGet() { }

    public async Task<IActionResult> OnPostAsync(string password, string? returnUrl)
    {
        if (password != _password)
        {
            Error = "Incorrect password.";
            return Page();
        }

        var claims = new[] { new Claim(ClaimTypes.Name, "user") };
        var identity = new ClaimsIdentity(claims, "Cookies");
        var principal = new ClaimsPrincipal(identity);

        await HttpContext.SignInAsync("Cookies", principal, new AuthenticationProperties
        {
            IsPersistent = true,
            ExpiresUtc = DateTimeOffset.UtcNow.AddDays(30)
        });

        return Redirect(string.IsNullOrEmpty(returnUrl) ? "/" : returnUrl);
    }
}
