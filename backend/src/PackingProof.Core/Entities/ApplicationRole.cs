using Microsoft.AspNetCore.Identity;

namespace PackingProof.Core.Entities;

public class ApplicationRole : IdentityRole<Guid>
{
    public string Description { get; set; } = string.Empty;
    public bool IsSystemRole { get; set; }
    public DateTime CreatedAtUtc { get; set; } = DateTime.UtcNow;

    public ICollection<RolePermission> RolePermissions { get; set; } = new List<RolePermission>();
    public ICollection<UserScopeGrant> ScopeGrants { get; set; } = new List<UserScopeGrant>();
}

