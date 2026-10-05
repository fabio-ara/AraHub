-- Identity/origin, scope and epoch changes are inseparable from the protected vault lifecycle.
-- A direct Data API UPDATE must not redirect a credential to another public origin or undo a fence.
revoke update on public.hub_connections from authenticated;
