// Window functions and QUALIFY.
//
// M has no OVER clause, so each window is spelled out as ordinary, inspectable
// steps (all of them buttons in the Power Query UI):
//
//   1. sort the rows by PARTITION BY, then ORDER BY (buffered, so positions
//      are stable) and number them: "Row Index";
//   2. group by the partition keys to find where each partition starts and
//      how many rows it has, and merge that back;
//   3. when ORDER BY ties matter, group by partition + order keys to find each
//      row's peers (rows that tie), and merge that back;
//   4. add one column per window function, computed from those numbers and
//      from the argument column read by position in window order.
//
// Merges here deliberately match null to null: PARTITION BY puts all NULL
// keys in one partition, and ORDER BY treats NULLs as peers of each other.

///|
fn collect_windows(e : Expr, acc : Array[Win]) -> Unit {
  if e is Window(w) {
    if !acc.contains(w) {
      acc.push(w)
    }
    return
  }
  for c in children(e) {
    collect_windows(c, acc)
  }
}

///|
/// Order of rows within a partition decides the result, so ties on ORDER BY
/// make SQL's answer arbitrary.
fn tie_sensitive(w : Win) -> Bool {
  match w.fname {
    "row_number" | "ntile" | "lag" | "lead" => true
    "first_value" | "last_value" | "nth_value" => true
    "rank" | "dense_rank" | "percent_rank" | "cume_dist" => false
    _ =>
      w.start is (CurrentRow | Preceding(_) | Following(_)) ||
      w.end is (CurrentRow | Preceding(_) | Following(_))
  }
}

///|
fn needs_peers(w : Win) -> Bool {
  if w.orders.length() == 0 {
    return false
  }
  match w.fname {
    "rank" | "dense_rank" | "percent_rank" | "cume_dist" => true
    "row_number" | "ntile" | "lag" | "lead" => false
    _ => w.start == CurrentPeer || w.end == CurrentPeer
  }
}

///|
fn add_hidden(frame : Frame, m : String, ty : Ty, notnull : Bool) -> Frame {
  {
    ref_: frame.ref_,
    cols: [..frame.cols, { qual: "", name: m, m, ty, hidden: true, notnull, }],
  }
}

///|
/// Column holding `e`: an existing column, an already computed expression,
/// or a new "Window Key" column.
fn window_column(
  ctx : Ctx,
  prefix : String,
  frame : Frame,
  rewrite : Array[(Expr, String, Ty)],
  e : Expr,
) -> (Frame, String, Ty, Bool) raise Refuse {
  let env = { frames: [(frame, "")], rewrite, prefer_last: false, }
  if rewrite.search_by(fn(r) { r.0 == e }) is Some(j) {
    return (frame, rewrite[j].1, rewrite[j].2, true)
  }
  if e is Col(names) {
    let (_, c) = resolve(env, names)
    return (frame, c.m, c.ty, !c.notnull)
  }
  let v = val(env, e)
  let m = unique_col(col_names(frame), "Window Key")
  let ref_ = ctx.step(
    prefix,
    "Added " + m,
    "Table.AddColumn(" +
    frame.ref_ +
    ", " +
    m_text(m) +
    ", each " +
    v.text +
    type_arg(v.ty) +
    ")",
  )
  (add_hidden(with_ref(frame, ref_), m, v.ty, !v.nullable), m, v.ty, v.nullable)
}

///|
/// `OVER (PARTITION BY a ORDER BY b DESC)` in terms of the key columns.
fn over_text(
  part_cols : Array[String],
  order_keys : Array[(String, Bool, Bool, Bool)],
) -> String {
  let parts = []
  if part_cols.length() > 0 {
    parts.push("PARTITION BY " + part_cols.join(", "))
  }
  if order_keys.length() > 0 {
    parts.push(
      "ORDER BY " +
      order_keys.map(fn(k) { if k.1 { k.0 + " DESC" } else { k.0 } }).join(", "),
    )
  }
  "OVER (" + parts.join(" ") + ")"
}

///|
fn window_name(w : Win, items : Array[SelectItem]) -> String {
  match items.search_by(fn(it) { it.expr == Window(w) && it.as_name != "" }) {
    Some(j) => items[j].as_name
    None => w.fname
  }
}

///|
/// Adds the window columns for every window function in `wins`, extending
/// `rewrite` so later steps read them by expression.
fn compile_windows(
  ctx : Ctx,
  prefix : String,
  frame0 : Frame,
  rewrite : Array[(Expr, String, Ty)],
  wins : Array[Win],
  items : Array[SelectItem],
) -> Frame raise Refuse {
  let mut frame = frame0
  let done : Array[Win] = []
  for w in wins {
    if done.contains(w) {
      continue
    }
    let same = wins.filter(fn(x) {
      x.partitions == w.partitions && x.orders == w.orders
    })
    for x in same {
      done.push(x)
    }
    frame = compile_window_spec(ctx, prefix, frame, rewrite, same, items)
  }
  frame
}

///|
fn compile_window_spec(
  ctx : Ctx,
  prefix : String,
  frame0 : Frame,
  rewrite : Array[(Expr, String, Ty)],
  wins : Array[Win],
  items : Array[SelectItem],
) -> Frame raise Refuse {
  let spec = wins[0]
  let mut frame = frame0
  // Validate arguments up front.
  for w in wins {
    let want = match w.fname {
      "row_number" | "rank" | "dense_rank" | "percent_rank" | "cume_dist" => 0
      "ntile"
      | "lag"
      | "lead"
      | "first_value"
      | "last_value"
      | "sum"
      | "avg"
      | "min"
      | "max" => 1
      "nth_value" => 2
      _ => w.args.length() // count / count(*)
    }
    if w.args.length() != want || (w.args.length() > 1 && w.fname == "count") {
      raise Refuse(
        "\{w.fname}() takes \{want} argument(s) as a window function.",
      )
    }
    if w.fname == "ntile" &&
      whole_number(w.args[0], "The ntile() bucket count") < 1 {
      raise Refuse("ntile() needs at least one bucket.")
    }
    if w.fname == "nth_value" &&
      whole_number(w.args[1], "The nth_value() position") < 1 {
      raise Refuse("nth_value() positions start at 1.")
    }
  }
  // Key and argument columns.
  let part_cols = []
  for p in spec.partitions {
    let (f, m, _, _) = window_column(ctx, prefix, frame, rewrite, p)
    frame = f
    if !part_cols.contains(m) {
      part_cols.push(m)
    }
  }
  let order_keys = []
  let order_cols = []
  for o in spec.orders {
    let (f, m, _, nullable) = window_column(ctx, prefix, frame, rewrite, o.expr)
    frame = f
    order_keys.push((m, o.desc, o.nulls_first, nullable))
    if !order_cols.contains(m) {
      order_cols.push(m)
    }
  }
  let arg_cols : Array[(String, Ty)] = []
  for w in wins {
    if w.args.length() > 0 && w.fname != "ntile" {
      let (f, m, ty, _) = window_column(ctx, prefix, frame, rewrite, w.args[0])
      frame = f
      arg_cols.push((m, ty))
    } else {
      arg_cols.push(("", TNum))
    }
  }
  let ties = wins.iter().any(tie_sensitive)
  let peers = wins.iter().any(needs_peers)
  let dense = spec.orders.length() > 0 &&
    wins.iter().any(fn(w) { w.fname == "dense_rank" })
  let over = over_text(part_cols, order_keys)
  let label = fn(ws : Array[Win]) -> String {
    ws.map(fn(w) { window_name(w, items) }).join(", ") + " " + over
  }
  if ties {
    let names = label(wins.filter(tie_sensitive))
    ctx.warnings.push(
      if spec.orders.length() == 0 {
        names +
        ": without ORDER BY, SQL may number or pick the rows in any order; the M uses the rows' input order."
      } else {
        names +
        ": when rows tie on the ORDER BY columns, SQL leaves their order undefined; the M breaks ties by input order, so DuckDB may pick a different row among ties. Add a unique column to ORDER BY to make it deterministic."
      },
    )
  }
  // 1. Window order.
  let what = if part_cols.length() > 0 && order_keys.length() > 0 {
    "partition, then ORDER BY"
  } else if part_cols.length() > 0 {
    "partition"
  } else if order_keys.length() > 0 {
    "ORDER BY"
  } else {
    "input order"
  }
  ctx.comment(
    "Window " +
    label(wins) +
    ": rows are sorted by " +
    what +
    " and numbered (Row Index); each partition is a block of consecutive rows.",
  )
  let sort_keys = part_cols.map(fn(m) { (m, false, true, false) })
  for k in order_keys {
    sort_keys.push(k)
  }
  if ties {
    let input = unique_col(col_names(frame), "Input Order")
    let ref_ = ctx.step(
      prefix,
      "Added " + input,
      "Table.AddIndexColumn(" + frame.ref_ + ", " + m_text(input) + ", 0, 1)",
    )
    frame = add_hidden(with_ref(frame, ref_), input, TNum, true)
    sort_keys.push((input, false, true, false))
  }
  if sort_keys.length() > 0 {
    let ref_ = ctx.step(
      prefix,
      "Sorted for Window",
      "Table.Buffer(Table.Sort(" +
      frame.ref_ +
      ", " +
      m_list(sort_criteria(sort_keys)) +
      "))",
    )
    frame = with_ref(frame, ref_)
  }
  let row_index = unique_col(col_names(frame), "Row Index")
  let idx_ref = ctx.step(
    prefix,
    "Added " + row_index,
    "Table.AddIndexColumn(" + frame.ref_ + ", " + m_text(row_index) + ", 0, 1)",
  )
  frame = add_hidden(with_ref(frame, idx_ref), row_index, TNum, true)
  let i = "[" + m_field(row_index) + "]"
  let mut merged = false
  // 2. Partition bounds.
  let (ps, pn) = if part_cols.length() > 0 {
    let start = unique_col(col_names(frame), "Partition Start")
    let rows = unique_col([..col_names(frame), start], "Partition Rows")
    let nested = unique_col(col_names(frame), "Partition")
    let bounds = ctx.step(
      prefix,
      "Partition Bounds",
      "Table.Group(" +
      idx_ref +
      ", " +
      m_text_list(part_cols) +
      ", {{" +
      m_text(start) +
      ", each List.Min(" +
      i +
      "), Int64.Type}, {" +
      m_text(rows) +
      ", each Table.RowCount(_), Int64.Type}})",
    )
    ctx.comment(
      "PARTITION BY puts all NULL keys in one partition; this merge matches null to null the same way, so nothing is filtered.",
    )
    let m1 = ctx.step(
      prefix,
      "Merged Partition Bounds",
      "Table.NestedJoin(" +
      frame.ref_ +
      ", " +
      m_text_list(part_cols) +
      ", " +
      bounds +
      ", " +
      m_text_list(part_cols) +
      ", " +
      m_text(nested) +
      ", JoinKind.LeftOuter)",
    )
    let m2 = ctx.step(
      prefix,
      "Expanded Partition Bounds",
      "Table.ExpandTableColumn(" +
      m1 +
      ", " +
      m_text(nested) +
      ", " +
      m_text_list([start, rows]) +
      ")",
    )
    frame = add_hidden(
      add_hidden(with_ref(frame, m2), start, TNum, true),
      rows,
      TNum,
      true,
    )
    merged = true
    ("[" + m_field(start) + "]", "[" + m_field(rows) + "]")
  } else {
    let count = ctx.step(prefix, "Row Count", "Table.RowCount(" + idx_ref + ")")
    ("0", count)
  }
  let last = if ps == "0" { pn + " - 1" } else { ps + " + " + pn + " - 1" }
  // 3. Peers.
  let mut peer_number = ""
  let (pf, pl) = if peers {
    let first = unique_col(col_names(frame), "Peer First")
    let lastc = unique_col([..col_names(frame), first], "Peer Last")
    let nested = unique_col(col_names(frame), "Peers")
    let keys = [..part_cols]
    for m in order_cols {
      if !keys.contains(m) {
        keys.push(m)
      }
    }
    let mut groups = ctx.step(
      prefix,
      "Peer Groups",
      "Table.Group(" +
      idx_ref +
      ", " +
      m_text_list(keys) +
      ", {{" +
      m_text(first) +
      ", each List.Min(" +
      i +
      "), Int64.Type}, {" +
      m_text(lastc) +
      ", each List.Max(" +
      i +
      "), Int64.Type}})",
    )
    let expanded = [first, lastc]
    if dense {
      peer_number = unique_col(
        [..col_names(frame), first, lastc],
        "Peer Number",
      )
      groups = ctx.step(
        prefix,
        "Numbered Peer Groups",
        "Table.AddIndexColumn(Table.Sort(" +
        groups +
        ", {{" +
        m_text(first) +
        ", Order.Ascending}}), " +
        m_text(peer_number) +
        ", 0, 1)",
      )
      expanded.push(peer_number)
    }
    ctx.comment(
      "Rows that tie on ORDER BY are peers; they share a rank, and a RANGE frame (the default) ends at the last of them. NULLs are peers of each other, and the merge matches null to null.",
    )
    let m1 = ctx.step(
      prefix,
      "Merged Peer Groups",
      "Table.NestedJoin(" +
      frame.ref_ +
      ", " +
      m_text_list(keys) +
      ", " +
      groups +
      ", " +
      m_text_list(keys) +
      ", " +
      m_text(nested) +
      ", JoinKind.LeftOuter)",
    )
    let m2 = ctx.step(
      prefix,
      "Expanded Peer Groups",
      "Table.ExpandTableColumn(" +
      m1 +
      ", " +
      m_text(nested) +
      ", " +
      m_text_list(expanded) +
      ")",
    )
    frame = with_ref(frame, m2)
    for m in expanded {
      frame = add_hidden(frame, m, TNum, true)
    }
    merged = true
    ("[" + m_field(first) + "]", "[" + m_field(lastc) + "]")
  } else if spec.orders.length() == 0 {
    // Without ORDER BY every row of the partition is a peer.
    (ps, last)
  } else {
    ("", "")
  }
  // 4. Positional reads need the rows in window order again after merges.
  if merged {
    let ref_ = ctx.step(
      prefix,
      "Window Order",
      "Table.Buffer(Table.Sort(" +
      frame.ref_ +
      ", {{" +
      m_text(row_index) +
      ", Order.Ascending}}))",
    )
    frame = with_ref(frame, ref_)
  }
  let window_ref = frame.ref_
  let lists : Map[String, String] = Map([])
  let values = fn(m : String) -> String {
    match lists.get(m) {
      Some(r) => r
      None => {
        let r = ctx.step(
          prefix,
          m + " in Window Order",
          "List.Buffer(" + window_ref + "[" + m_field(m) + "])",
        )
        lists[m] = r
        r
      }
    }
  }
  let rel = fn(x : String) -> String {
    if ps == "0" {
      x
    } else {
      x + " - " + ps
    }
  }
  // 5. One column per window function.
  for k, w in wins {
    let (arg, arg_ty) = arg_cols[k]
    let env = { frames: [(frame, "")], rewrite, prefer_last: false, }
    let bound = fn(b : Bound, is_start : Bool) -> String {
      match b {
        Unbounded => if is_start { ps } else { last }
        CurrentRow => i
        CurrentPeer => if is_start { pf } else { pl }
        Preceding(n) =>
          if is_start {
            "List.Max({" + ps + ", " + i + " - " + n.to_string() + "})"
          } else {
            i + " - " + n.to_string()
          }
        Following(n) =>
          if is_start {
            i + " + " + n.to_string()
          } else {
            "List.Min({" + last + ", " + i + " + " + n.to_string() + "})"
          }
      }
    }
    let (body, ty, notnull) = match w.fname {
      "row_number" => (rel(i) + " + 1", TNum, true)
      "rank" =>
        if w.orders.length() == 0 {
          ("1", TNum, true)
        } else {
          (rel(pf) + " + 1", TNum, true)
        }
      "dense_rank" =>
        if w.orders.length() == 0 {
          ("1", TNum, true)
        } else {
          let pnum = "[" + m_field(peer_number) + "]"
          let first_num = if ps == "0" {
            "0"
          } else {
            values(peer_number) + "{" + ps + "}"
          }
          if first_num == "0" {
            (pnum + " + 1", TNum, true)
          } else {
            (pnum + " - " + first_num + " + 1", TNum, true)
          }
        }
      "percent_rank" => {
        let r = if w.orders.length() == 0 { "0" } else { rel(pf) }
        (
          "if " + pn + " = 1 then 0 else (" + r + ") / (" + pn + " - 1)",
          TNum,
          true,
        )
      }
      "cume_dist" => {
        let upto = if w.orders.length() == 0 {
          pn
        } else {
          "(" + rel(pl) + " + 1)"
        }
        (upto + " / " + pn, TNum, true)
      }
      "ntile" => {
        let n = whole_number(w.args[0], "The ntile() bucket count").to_string()
        (
          "let buckets = List.Min({" +
          n +
          ", " +
          pn +
          "}), size = Number.IntegerDivide(" +
          pn +
          ", buckets), large = " +
          pn +
          " - buckets * size, pos = " +
          rel(i) +
          " in if pos < large * (size + 1) then 1 + Number.IntegerDivide(pos, size + 1) else 1 + large + Number.IntegerDivide(pos - large * (size + 1), size)",
          TNum,
          true,
        )
      }
      "lag" | "lead" => {
        let off = w.offset.to_string()
        let (j, ok) = if w.fname == "lag" {
          let j = i + " - " + off
          (j, j + " >= " + ps)
        } else {
          let j = i + " + " + off
          (j, j + " <= " + last)
        }
        let dflt = match w.default_ {
          Some(d) => val(env, coerce_literal(d, arg_ty)).text
          None => "null"
        }
        (
          "if " + ok + " then " + values(arg) + "{" + j + "} else " + dflt,
          arg_ty,
          false,
        )
      }
      _ => {
        let a = bound(w.start, true)
        let b = bound(w.end, false)
        if a == "" || b == "" {
          raise Refuse("internal error: window frame needs peer groups")
        }
        let may_be_empty = w.start is Following(_) || w.end is Preceding(_)
        let a_term = if a.contains(" ") { "(" + a + ")" } else { a }
        let count = if a == ps && b == last {
          pn
        } else {
          b + " - " + a_term + " + 1"
        }
        let range = "List.Range(" +
          (if w.fname == "count" && arg == "" { "" } else { values(arg) }) +
          ", " +
          a +
          ", " +
          count +
          ")"
        let (agg, ty, notnull, empty) = match w.fname {
          "count" =>
            if arg == "" {
              (count, TNum, true, "0")
            } else {
              ("List.NonNullCount(" + range + ")", TNum, true, "0")
            }
          "sum" => ("List.Sum(" + range + ")", TNum, false, "null")
          "avg" => ("List.Average(" + range + ")", TNum, false, "null")
          "min" => ("List.Min(" + range + ")", arg_ty, false, "null")
          "max" => ("List.Max(" + range + ")", arg_ty, false, "null")
          "first_value" => (values(arg) + "{" + a + "}", arg_ty, false, "null")
          "last_value" => (values(arg) + "{" + b + "}", arg_ty, false, "null")
          "nth_value" => {
            let n = whole_number(w.args[1], "The nth_value() position")
            let at = a + " + " + (n - 1).to_string()
            (
              "if " +
              at +
              " <= " +
              b +
              " then " +
              values(arg) +
              "{" +
              at +
              "} else null",
              arg_ty,
              false,
              "null",
            )
          }
          other => raise Refuse("Window function \{other}() is not supported.")
        }
        if may_be_empty {
          (
            "if " + a + " > " + b + " then " + empty + " else " + agg,
            ty,
            notnull,
          )
        } else {
          (agg, ty, notnull)
        }
      }
    }
    let base = window_name(w, items)
    let m = unique_col(col_names(frame), base)
    let ref_ = ctx.step(
      prefix,
      "Added " + m,
      "Table.AddColumn(" +
      frame.ref_ +
      ", " +
      m_text(m) +
      ", each " +
      body +
      type_arg(ty) +
      ")",
    )
    frame = add_hidden(with_ref(frame, ref_), m, ty, notnull)
    rewrite.push((Window(w), m, ty))
  }
  frame
}

///|
/// QUALIFY: a filter after the window columns exist. Select-list aliases may
/// be used in it, as in DuckDB.
fn qualify_step(
  ctx : Ctx,
  prefix : String,
  frame0 : Frame,
  rewrite : Array[(Expr, String, Ty)],
  q : Expr,
  items : Array[SelectItem],
) -> Frame raise Refuse {
  let mut frame = frame0
  let qrw = [..rewrite]
  let refs = []
  collect_alias_refs(q, refs)
  for name in refs {
    let resolves = try resolve(env1(frame), [name]) catch {
      _ => false
    } noraise {
      _ => true
    }
    if resolves {
      continue
    }
    guard items.search_by(fn(it) { it.as_name.to_lower() == name.to_lower() })
      is Some(j) else {
      continue
    }
    let e = items[j].expr
    match qrw.search_by(fn(r) { r.0 == e }) {
      Some(k) => qrw.push((Col([name]), qrw[k].1, qrw[k].2))
      None => {
        let env = { frames: [(frame, "")], rewrite: qrw, prefer_last: false, }
        let v = val(env, e)
        let m = unique_col(col_names(frame), name)
        let ref_ = ctx.step(
          prefix,
          "Added " + m,
          "Table.AddColumn(" +
          frame.ref_ +
          ", " +
          m_text(m) +
          ", each " +
          v.text +
          type_arg(v.ty) +
          ")",
        )
        frame = add_hidden(with_ref(frame, ref_), m, v.ty, !v.nullable)
        qrw.push((Col([name]), m, v.ty))
      }
    }
  }
  let env = { frames: [(frame, "")], rewrite: qrw, prefer_last: false, }
  filter_step(ctx, prefix, "Qualified Rows", frame, [
    wrap(pred(env, q, true), AND),
  ])
}

///|
fn collect_alias_refs(e : Expr, acc : Array[String]) -> Unit {
  match e {
    Col([name]) => if !acc.contains(name) { acc.push(name) }
    Window(_) => ()
    _ =>
      for c in children(e) {
        collect_alias_refs(c, acc)
      }
  }
}
