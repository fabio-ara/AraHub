-- Some hosted projects include this provider event trigger in public.
-- Its privileged owner may keep automatic RLS enforcement; API roles must not call it.
do $guard$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end $guard$;
