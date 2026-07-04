/** dt/dd rows for the `.kv` definition-list styling. */
export function Kv({ rows, id }: { rows: [string, string][]; id?: string }) {
  return (
    <dl class="kv" id={id}>
      {rows.map(([k, v]) => (
        <>
          <dt key={`${k}-t`}>{k}</dt>
          <dd key={`${k}-d`}>{v}</dd>
        </>
      ))}
    </dl>
  );
}
