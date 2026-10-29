using PackingProof.Core.Enums;

namespace PackingProof.Core.Entities;

public class UserScopeGrant
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid UserId { get; set; }
    public ApplicationUser User { get; set; } = null!;

    public Guid RoleId { get; set; }
    public ApplicationRole Role { get; set; } = null!;

    public ScopeType ScopeType { get; set; }
    public Guid? ShopId { get; set; }
    public Shop? Shop { get; set; }
    public Guid? WarehouseId { get; set; }
    public Warehouse? Warehouse { get; set; }

    public Guid? GrantedByUserId { get; set; }
    public ApplicationUser? GrantedByUser { get; set; }
    public DateTime CreatedAtUtc { get; set; } = DateTime.UtcNow;
}

