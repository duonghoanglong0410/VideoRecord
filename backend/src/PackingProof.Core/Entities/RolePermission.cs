namespace PackingProof.Core.Entities;

public class RolePermission
{
    public Guid RoleId { get; set; }
    public ApplicationRole Role { get; set; } = null!;

    public string PermissionCode { get; set; } = string.Empty;
    public Permission Permission { get; set; } = null!;
}

