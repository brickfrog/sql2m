// Queries -> a chain of named M steps.

///|
fn compile_query(ctx : Ctx, q : Query, prefix : String) -> Rel raise Refuse {
  let ctes = match q {
    Select(node) => node.ctes
    SetOp(_, _, _, _, ctes, _) => ctes
  }
  ctx.scopes.push({})
  compile_ctes(ctx, ctes)
  let rel = match q {
    Select(node) => compile_select(ctx, node, prefix)
    SetOp(_, _, _, _, _, _) => compile_setop(ctx, q, prefix)
  }
  ctx.scopes.pop() |> ignore
  rel
}

///|
fn compile_ctes(ctx : Ctx, ctes : Array[Cte]) -> Unit raise Refuse {
  for cte in ctes {
    let mark = ctx.steps.length()
    ctx.comment("── " + cte.name + " ──")
    let rel = compile_query(ctx, cte.query, cte.name)
    let rel = apply_aliases(ctx, cte.name, rel, cte.aliases)
    let ref_ = ctx.finish_named(mark, rel.ref_, cte.name)
    ctx.pending = []
    ctx.scopes[ctx.scopes.length() - 1][cte.name.to_lower()] = {
      ref_,
      cols: rel.cols,
    }
  }
}

///|
fn apply_aliases(
  ctx : Ctx,
  prefix : String,
  rel : Rel,
  aliases : Array[String],
) -> Rel raise Refuse {
  if aliases.length() == 0 {
    return rel
  }
  if aliases.length() > rel.cols.length() {
    raise Refuse(
      "\{prefix} lists \{aliases.length()} column names but produces \{rel.cols.length()} columns.",
    )
  }
  let pairs = []
  let cols = []
  for i, c in rel.cols {
    if i < aliases.length() && aliases[i] != c.name {
      pairs.push(m_text_list([c.name, aliases[i]]))
      cols.push({ ..c, name: aliases[i], })
    } else {
      cols.push(c)
    }
  }
  if pairs.length() == 0 {
    return rel
  }
  let ref_ = ctx.step(
    prefix,
    "Renamed Columns",
    "Table.RenameColumns(" + rel.ref_ + ", " + m_list(pairs) + ")",
  )
  { ref_, cols, }
}

// ---------------------------------------------------------------------------
// Frames

///|
fn frame_of(rel : Rel, qual : String) -> Frame {
  {
    ref_: rel.ref_,
    cols: rel.cols.map(fn(c) {
      {
        qual: qual.to_lower(),
        name: c.name,
        m: c.name,
        ty: c.ty,
        hidden: false,
        notnull: c.notnull,
      }
    }),
  }
}

///|
fn with_ref(f : Frame, ref_ : String) -> Frame {
  { ..f, ref_, }
}

///|
fn col_names(f : Frame) -> Array[String] {
  f.cols.map(fn(c) { c.m })
}

///|
fn unique_col(taken : Array[String], base : String) -> String {
  if !taken.contains(base) {
    return base
  }
  let mut i = 2
  while taken.contains(base + "_" + i.to_string()) {
    i = i + 1
  }
  base + "_" + i.to_string()
}

///|
fn type_arg(ty : Ty) -> String {
  match ty {
    TNum => ", type number"
    TText => ", type text"
    TDate => ", type date"
    TDateTime => ", type datetime"
    TBool => ", type logical"
    TAny => ""
  }
}

///|
fn ref_label(t : TableRef) -> String {
  match t {
    Base(name, as_name) => if as_name != "" { as_name } else { name }
    Sub(_, as_name, _) => if as_name != "" { as_name } else { "Subquery" }
    Join(_, _, _, _, _, _) => "Joined"
    NoFrom => "Rows"
  }
}

///|
fn sub_prefix(prefix : String, name : String) -> String {
  if prefix == "" {
    name
  } else {
    prefix + " " + name
  }
}

///|
fn filter_step(
  ctx : Ctx,
  prefix : String,
  label : String,
  frame : Frame,
  conds : Array[String],
) -> Frame {
  if conds.length() == 0 {
    return frame
  }
  let ref_ = ctx.step(
    prefix,
    label,
    "Table.SelectRows(" + frame.ref_ + ", each " + conds.join(" and ") + ")",
  )
  with_ref(frame, ref_)
}

///|
fn pred_texts(env : Env, conds : Array[Expr]) -> Array[String] raise Refuse {
  let out = []
  for c in conds {
    out.push(wrap(pred(env, c, true), AND))
  }
  out
}

// ---------------------------------------------------------------------------
// FROM

///|
fn compile_from(ctx : Ctx, t : TableRef, prefix : String) -> Frame raise Refuse {
  match t {
    NoFrom => { ref_: "#table({}, {{}})", cols: [], }
    Base(name, as_name) =>
      match ctx.lookup_relation(name) {
        Some(rel) => frame_of(rel, if as_name != "" { as_name } else { name })
        None =>
          raise Refuse(
            "Unknown table \{name}. Declare it in the Tables pane (CREATE TABLE \{name} (...)); it becomes a Power Query query of the same name.",
          )
      }
    Sub(q, _, aliases) => {
      let label = ref_label(t)
      let p = sub_prefix(prefix, label)
      let rel = compile_query(ctx, q, p)
      let rel = apply_aliases(ctx, p, rel, aliases)
      frame_of(rel, label)
    }
    Join(kind, lt, rt, cond, using_cols, natural) => {
      let fl = compile_from(ctx, lt, prefix)
      let fr = compile_from(ctx, rt, prefix)
      join_frames(
        ctx,
        prefix,
        kind,
        fl,
        ref_label(lt),
        fr,
        ref_label(rt),
        cond,
        using_cols,
        natural,
        false,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Joins

///|
priv enum KeySide {
  KeyCol(FCol)
  KeyExpr(Expr)
}

///|
priv struct KeyPair {
  l : KeySide
  r : KeySide
  null_safe : Bool
}

///|
fn key_side(env : Env, e : Expr) -> KeySide raise Refuse {
  match e {
    Col(names) => KeyCol(resolve(env, names).1)
    _ => KeyExpr(e)
  }
}

///|
/// Materialises join keys as columns; returns (frame, key columns, temp columns).
fn key_columns(
  ctx : Ctx,
  prefix : String,
  label : String,
  frame : Frame,
  sides : Array[KeySide],
) -> (Frame, Array[String], Array[String], Array[Bool]) raise Refuse {
  let mut f = frame
  let keys = []
  let temps = []
  let nullable = []
  for s in sides {
    match s {
      KeyCol(c) => {
        keys.push(c.m)
        nullable.push(!c.notnull)
      }
      KeyExpr(e) => {
        let v = val(env1(f), e)
        let m = unique_col(col_names(f), label + " key")
        let ref_ = ctx.step(
          prefix,
          "Added " + m,
          "Table.AddColumn(" +
          f.ref_ +
          ", " +
          m_text(m) +
          ", each " +
          v.text +
          type_arg(v.ty) +
          ")",
        )
        f = {
          ref_,
          cols: [
            ..f.cols,
            {
              qual: "",
              name: m,
              m,
              ty: v.ty,
              hidden: true,
              notnull: !v.nullable,
            },
          ],
        }
        keys.push(m)
        temps.push(m)
        nullable.push(v.nullable)
      }
    }
  }
  (f, keys, temps, nullable)
}

///|
fn null_key_conds(
  keys : Array[String],
  nullable : Array[Bool],
  pairs : Array[KeyPair],
) -> Array[String] {
  let out = []
  for i, k in keys {
    if nullable[i] && !pairs[i].null_safe {
      out.push("[" + m_field(k) + "] <> null")
    }
  }
  out
}

///|
fn key_text(
  fl : Frame,
  lk : Array[String],
  rlabel : String,
  rk : Array[String],
) -> String {
  ignore(fl)
  let parts = []
  for i, k in lk {
    parts.push(k + " = " + rlabel + "." + rk[i])
  }
  parts.join(" and ")
}

///|
/// Expands the nested join column; right-side names that collide with an
/// existing column get the "alias." prefix Power Query itself would suggest.
fn expand(
  ctx : Ctx,
  prefix : String,
  rlabel : String,
  ref_ : String,
  left_cols : Array[FCol],
  nested : String,
  fr : Frame,
  temps : Array[String],
) -> Frame {
  let taken = left_cols.map(fn(c) { c.m })
  let names = []
  let fresh = []
  let cols = [..left_cols]
  for c in fr.cols {
    if temps.contains(c.m) {
      continue
    }
    let mut nm = c.m
    if taken.contains(nm) {
      nm = unique_col(
        taken,
        (if c.qual != "" { c.qual } else { rlabel }) + "." + c.name,
      )
    }
    taken.push(nm)
    names.push(c.m)
    fresh.push(nm)
    cols.push({ ..c, m: nm, })
  }
  let rename = if names == fresh { "" } else { ", " + m_text_list(fresh) }
  let out = ctx.step(
    prefix,
    "Expanded " + rlabel,
    "Table.ExpandTableColumn(" +
    ref_ +
    ", " +
    m_text(nested) +
    ", " +
    m_text_list(names) +
    rename +
    ")",
  )
  { ref_: out, cols, }
}

///|
fn remove_cols(
  ctx : Ctx,
  prefix : String,
  frame : Frame,
  cols : Array[String],
) -> Frame {
  if cols.length() == 0 {
    return frame
  }
  let ref_ = ctx.step(
    prefix,
    "Removed Columns",
    "Table.RemoveColumns(" + frame.ref_ + ", " + m_text_list(cols) + ")",
  )
  { ref_, cols: frame.cols.filter(fn(c) { !cols.contains(c.m) }), }
}

///|
let null_key_note : String = "Power Query merges match null keys to each other; SQL never matches NULL, so null-key rows are filtered out of the right side first."

///|
fn join_frames(
  ctx : Ctx,
  prefix : String,
  kind0 : JoinKind,
  fl : Frame,
  llabel : String,
  fr : Frame,
  rlabel : String,
  cond : Expr?,
  using0 : Array[String],
  natural : Bool,
  prefer_right : Bool,
) -> Frame raise Refuse {
  let env2 : Env = {
    frames: [(fl, "l"), (fr, "r")],
    rewrite: [],
    prefer_last: prefer_right,
  }
  let using_cols = if natural {
    let common = []
    for c in fl.cols {
      if !c.hidden &&
        fr.cols
        .iter()
        .any(fn(d) { !d.hidden && d.name.to_lower() == c.name.to_lower() }) {
        common.push(c.name)
      }
    }
    common
  } else {
    using0
  }
  let mut kind = kind0
  if (kind == Inner || natural) && cond is None && using_cols.length() == 0 {
    kind = Cross
  }
  let pairs : Array[KeyPair] = []
  let lf = []
  let rf = []
  let residual = []
  let mut fl_cols = fl.cols
  let mut fr_cols = fr.cols
  for u in using_cols {
    let (_, lc) = resolve(env1(fl), [u])
    let (_, rc) = resolve(env1(fr), [u])
    pairs.push({ l: KeyCol(lc), r: KeyCol(rc), null_safe: false, })
    match kind {
      Full =>
        raise Refuse(
          "FULL JOIN ... USING merges the key columns with COALESCE; write it with ON and pick the columns explicitly.",
        )
      Right =>
        fl_cols = fl_cols.map(fn(c) {
          if c.m == lc.m {
            { ..c, hidden: true, }
          } else {
            c
          }
        })
      _ =>
        fr_cols = fr_cols.map(fn(c) {
          if c.m == rc.m {
            { ..c, hidden: true, }
          } else {
            c
          }
        })
    }
  }
  let fl = { ..fl, cols: fl_cols, }
  let fr = { ..fr, cols: fr_cols, }
  let env_l = env1(fl)
  let env_r = env1(fr)
  if cond is Some(c) {
    for part in split_and(c) {
      if part is Const(LBool(true)) {
        continue
      }
      let used = [false, false]
      frames_used(env2, part, used)
      let mut keyed = false
      if part is Cmp(op, a, b) && (op == Eq || op == NotDistinct) {
        let ua = [false, false]
        let ub = [false, false]
        frames_used(env2, a, ua)
        frames_used(env2, b, ub)
        let safe = op == NotDistinct
        if ua[0] && !ua[1] && ub[1] && !ub[0] {
          pairs.push({
            l: key_side(env_l, a),
            r: key_side(env_r, b),
            null_safe: safe,
          })
          keyed = true
        } else if ub[0] && !ub[1] && ua[1] && !ua[0] {
          pairs.push({
            l: key_side(env_l, b),
            r: key_side(env_r, a),
            null_safe: safe,
          })
          keyed = true
        }
      }
      if keyed {
        continue
      }
      match (used[0], used[1]) {
        (true, false) => lf.push(part)
        (false, true) => rf.push(part)
        _ => residual.push(part)
      }
    }
  }
  if kind == Cross {
    return cross_join(ctx, prefix, fl, fr, rlabel)
  }
  match kind {
    Right =>
      if rf.length() > 0 || residual.length() > 0 {
        // Mirror into a LEFT join, then restore SQL column order.
        let swapped = pairs.map(fn(p) {
          { l: p.r, r: p.l, null_safe: p.null_safe, }
        })
        let joined = outer_left(
          ctx, prefix, fr, fl, llabel, swapped, rf, lf, residual, "right",
        )
        let n_right = fr.cols.length()
        let left_part = joined.cols[n_right:].to_owned()
        let right_part = joined.cols[:n_right].to_owned()
        let cols = [..left_part, ..right_part]
        let ref_ = ctx.step(
          prefix,
          "Reordered Columns",
          "Table.ReorderColumns(" +
          joined.ref_ +
          ", " +
          m_text_list(cols.map(fn(c) { c.m })) +
          ")",
        )
        { ref_, cols, }
      } else {
        let (fl1, lk, ltemp, lnull) = key_columns(
          ctx,
          prefix,
          llabel,
          fl,
          pairs.map(fn(p) { p.l }),
        )
        let (fr1, rk, rtemp, _) = key_columns(
          ctx,
          prefix,
          rlabel,
          fr,
          pairs.map(fn(p) { p.r }),
        )
        let conds = pred_texts(env1(fl1), lf)
        let nulls = null_key_conds(lk, lnull, pairs)
        if nulls.length() > 0 {
          ctx.comment(null_key_note.replace(old="right side", new="left side"))
        }
        let fl2 = filter_step(
          ctx,
          prefix,
          "Filtered " + llabel,
          fl1,
          [..conds, ..nulls],
        )
        let nested = unique_col(col_names(fl2), rlabel)
        ctx.comment(
          "Right join on " +
          key_text(fl2, lk, rlabel, rk) +
          ": every " +
          rlabel +
          " row is kept; it repeats once per matching " +
          llabel +
          " row, unmatched rows get nulls on the left.",
        )
        let merged = ctx.step(
          prefix,
          "Merged " + rlabel,
          "Table.NestedJoin(" +
          fl2.ref_ +
          ", " +
          m_text_list(lk) +
          ", " +
          fr1.ref_ +
          ", " +
          m_text_list(rk) +
          ", " +
          m_text(nested) +
          ", JoinKind.RightOuter)",
        )
        let out = expand(
          ctx,
          prefix,
          rlabel,
          merged,
          fl2.cols,
          nested,
          fr1,
          rtemp,
        )
        remove_cols(ctx, prefix, out, ltemp)
      }
    Left =>
      outer_left(ctx, prefix, fl, fr, rlabel, pairs, lf, rf, residual, "left")
    Inner => {
      let fl1 = filter_step(
        ctx,
        prefix,
        "Filtered " + llabel,
        fl,
        pred_texts(env_l, lf),
      )
      let (fl2, lk, ltemp, _) = key_columns(
        ctx,
        prefix,
        llabel,
        fl1,
        pairs.map(fn(p) { p.l }),
      )
      let (fr2, rk, rtemp, rnull) = key_columns(
        ctx,
        prefix,
        rlabel,
        fr,
        pairs.map(fn(p) { p.r }),
      )
      let fr3 = right_prefilter(ctx, prefix, rlabel, fr2, rf, rk, rnull, pairs)
      let joined = if pairs.length() == 0 {
        let x = cross_join(ctx, prefix, fl2, fr3, rlabel)
        x
      } else {
        let nested = unique_col(col_names(fl2), rlabel)
        ctx.comment(
          "Inner join on " +
          key_text(fl2, lk, rlabel, rk) +
          ": one row per matching pair; a row repeats when its key matches several " +
          rlabel +
          " rows, and rows without a match are dropped.",
        )
        let merged = ctx.step(
          prefix,
          "Merged " + rlabel,
          "Table.NestedJoin(" +
          fl2.ref_ +
          ", " +
          m_text_list(lk) +
          ", " +
          fr3.ref_ +
          ", " +
          m_text_list(rk) +
          ", " +
          m_text(nested) +
          ", JoinKind.Inner)",
        )
        expand(ctx, prefix, rlabel, merged, fl2.cols, nested, fr3, rtemp)
      }
      let filtered = filter_step(
        ctx,
        prefix,
        "Filtered Rows",
        joined,
        pred_texts(env1(joined), residual),
      )
      remove_cols(ctx, prefix, filtered, ltemp)
    }
    Semi | Anti => {
      let semi = kind == Semi
      let (fl1, generic_left) = if semi {
        (
          filter_step(
            ctx,
            prefix,
            "Filtered " + llabel,
            fl,
            pred_texts(env_l, lf),
          ),
          [],
        )
      } else {
        (fl, lf)
      }
      let (fl2, lk, ltemp, _) = key_columns(
        ctx,
        prefix,
        llabel,
        fl1,
        pairs.map(fn(p) { p.l }),
      )
      let (fr2, rk, _, rnull) = key_columns(
        ctx,
        prefix,
        rlabel,
        fr,
        pairs.map(fn(p) { p.r }),
      )
      let fr3 = right_prefilter(ctx, prefix, rlabel, fr2, rf, rk, rnull, pairs)
      let extra = [..generic_left, ..residual]
      let nested = unique_col(col_names(fl2), rlabel)
      let what = if semi {
        "Semi join on " +
        key_text(fl2, lk, rlabel, rk) +
        ": keeps each row that has at least one match in " +
        rlabel +
        ", once; it never duplicates rows."
      } else {
        "Anti join on " +
        key_text(fl2, lk, rlabel, rk) +
        ": keeps the rows with no match in " +
        rlabel +
        "; it never duplicates rows."
      }
      if extra.length() == 0 && pairs.length() > 0 {
        ctx.comment(what)
        let merged = ctx.step(
          prefix,
          (if semi { "Kept rows matching " } else { "Removed rows matching " }) +
          rlabel,
          "Table.NestedJoin(" +
          fl2.ref_ +
          ", " +
          m_text_list(lk) +
          ", " +
          fr3.ref_ +
          ", " +
          m_text_list(rk) +
          ", " +
          m_text(nested) +
          ", " +
          (if semi { "JoinKind.Inner" } else { "JoinKind.LeftAnti" }) +
          ")",
        )
        remove_cols(
          ctx,
          prefix,
          { ref_: merged, cols: fl2.cols, },
          [nested, ..ltemp],
        )
      } else {
        ctx.comment(what)
        let matched = matched_rows(
          ctx, prefix, fl2, lk, fr3, rk, rlabel, nested, extra,
        )
        let kept = ctx.step(
          prefix,
          if semi {
            "Kept matched rows"
          } else {
            "Kept unmatched rows"
          },
          "Table.SelectRows(" +
          matched.ref_ +
          ", each " +
          (if semi { "not " } else { "" }) +
          "Table.IsEmpty([" +
          m_field(nested) +
          "]))",
        )
        remove_cols(
          ctx,
          prefix,
          { ref_: kept, cols: fl2.cols, },
          [nested, ..ltemp],
        )
      }
    }
    Full => {
      if lf.length() > 0 || rf.length() > 0 || residual.length() > 0 {
        raise Refuse(
          "FULL JOIN is only supported with equality conditions between the two tables (ON a.x = b.y AND ...). Filter the inputs in CTEs first.",
        )
      }
      if pairs.length() == 0 {
        raise Refuse("FULL JOIN needs at least one equality condition.")
      }
      let (fl2, lk, ltemp, _) = key_columns(
        ctx,
        prefix,
        llabel,
        fl,
        pairs.map(fn(p) { p.l }),
      )
      let (fr2, rk, rtemp, rnull) = key_columns(
        ctx,
        prefix,
        rlabel,
        fr,
        pairs.map(fn(p) { p.r }),
      )
      let nulls = null_key_conds(rk, rnull, pairs)
      let fr3 = if nulls.length() > 0 {
        ctx.comment(
          "Power Query merges match null keys to each other; SQL never matches NULL. Null-key " +
          rlabel +
          " rows are set aside and appended unmatched below.",
        )
        filter_step(ctx, prefix, rlabel + " with keys", fr2, nulls)
      } else {
        fr2
      }
      let nested = unique_col(col_names(fl2), rlabel)
      ctx.comment(
        "Full outer join on " +
        key_text(fl2, lk, rlabel, rk) +
        ": every row of both sides is kept; matched rows repeat once per match, unmatched rows get nulls on the other side.",
      )
      let merged = ctx.step(
        prefix,
        "Merged " + rlabel,
        "Table.NestedJoin(" +
        fl2.ref_ +
        ", " +
        m_text_list(lk) +
        ", " +
        fr3.ref_ +
        ", " +
        m_text_list(rk) +
        ", " +
        m_text(nested) +
        ", JoinKind.FullOuter)",
      )
      let expanded = expand(
        ctx,
        prefix,
        rlabel,
        merged,
        fl2.cols,
        nested,
        fr3,
        rtemp,
      )
      let out = if nulls.length() > 0 {
        let null_cond = nulls.map(fn(t) {
          t.replace(old=" <> null", new=" = null")
        })
        let null_rows = ctx.step(
          prefix,
          rlabel + " with null keys",
          "Table.SelectRows(" +
          fr2.ref_ +
          ", each " +
          null_cond.join(" or ") +
          ")",
        )
        // Give the set-aside rows the expanded column names.
        let renames = []
        let n_left = fl2.cols.length()
        let mut j = n_left
        for c in fr2.cols {
          if rtemp.contains(c.m) {
            continue
          }
          let target = expanded.cols[j].m
          if target != c.m {
            renames.push(m_text_list([c.m, target]))
          }
          j = j + 1
        }
        let renamed = if renames.length() > 0 {
          ctx.step(
            prefix,
            "Renamed " + rlabel + " with null keys",
            "Table.RenameColumns(" + null_rows + ", " + m_list(renames) + ")",
          )
        } else {
          null_rows
        }
        let appended = ctx.step(
          prefix,
          "Appended null-key " + rlabel,
          "Table.Combine({" + expanded.ref_ + ", " + renamed + "})",
        )
        let tmp_cols = [..expanded.cols]
        for t in rtemp {
          tmp_cols.push({
            qual: "",
            name: t,
            m: t,
            ty: TAny,
            hidden: true,
            notnull: false,
          })
        }
        remove_cols(
          ctx,
          prefix,
          { ref_: appended, cols: tmp_cols, },
          [..ltemp, ..rtemp],
        )
      } else {
        remove_cols(ctx, prefix, expanded, ltemp)
      }
      out
    }
    Cross => cross_join(ctx, prefix, fl, fr, rlabel)
  }
}

///|
fn right_prefilter(
  ctx : Ctx,
  prefix : String,
  rlabel : String,
  fr : Frame,
  rf : Array[Expr],
  rk : Array[String],
  rnull : Array[Bool],
  pairs : Array[KeyPair],
) -> Frame raise Refuse {
  let conds = pred_texts(env1(fr), rf)
  let nulls = null_key_conds(rk, rnull, pairs)
  if nulls.length() > 0 {
    ctx.comment(null_key_note)
  }
  filter_step(ctx, prefix, "Filtered " + rlabel, fr, [..conds, ..nulls])
}

///|
/// Adds `nested` = the rows of `fr` matching each row of `fl` under the key
/// equality plus the extra conditions (which may mention both sides).
fn matched_rows(
  ctx : Ctx,
  prefix : String,
  fl : Frame,
  lk : Array[String],
  fr : Frame,
  rk : Array[String],
  rlabel : String,
  nested : String,
  extra : Array[Expr],
) -> Frame raise Refuse {
  let env : Env = {
    frames: [(fl, "l"), (fr, "r")],
    rewrite: [],
    prefer_last: false,
  }
  let p = if extra.length() == 0 {
    ""
  } else {
    pred_texts(env, extra).join(" and ")
  }
  if lk.length() == 0 {
    let body = if p == "" {
      "each " + fr.ref_
    } else {
      "(l) => Table.SelectRows(" + fr.ref_ + ", (r) => " + p + ")"
    }
    let ref_ = ctx.step(
      prefix,
      "Matched " + rlabel,
      "Table.AddColumn(" + fl.ref_ + ", " + m_text(nested) + ", " + body + ")",
    )
    return { ref_, cols: fl.cols, }
  }
  let cand = unique_col(col_names(fl), rlabel + " candidates")
  let merged = ctx.step(
    prefix,
    "Merged " + rlabel,
    "Table.NestedJoin(" +
    fl.ref_ +
    ", " +
    m_text_list(lk) +
    ", " +
    fr.ref_ +
    ", " +
    m_text_list(rk) +
    ", " +
    m_text(cand) +
    ", JoinKind.LeftOuter)",
  )
  if p == "" {
    let renamed = ctx.step(
      prefix,
      "Renamed " + rlabel,
      "Table.RenameColumns(" +
      merged +
      ", {" +
      m_text(cand) +
      ", " +
      m_text(nested) +
      "})",
    )
    return { ref_: renamed, cols: fl.cols, }
  }
  let matched = ctx.step(
    prefix,
    "Matched " + rlabel,
    "Table.AddColumn(" +
    merged +
    ", " +
    m_text(nested) +
    ", (l) => Table.SelectRows(l[" +
    m_field(cand) +
    "], (r) => " +
    p +
    "))",
  )
  let removed = ctx.step(
    prefix,
    "Removed " + rlabel + " candidates",
    "Table.RemoveColumns(" + matched + ", {" + m_text(cand) + "})",
  )
  { ref_: removed, cols: fl.cols, }
}

///|
/// LEFT join of `fa` (preserved) with `fb`. `a_only`/`b_only` are ON
/// conditions touching one side, `residual` touches both.
fn outer_left(
  ctx : Ctx,
  prefix : String,
  fa : Frame,
  fb : Frame,
  blabel : String,
  pairs : Array[KeyPair],
  a_only : Array[Expr],
  b_only : Array[Expr],
  residual : Array[Expr],
  side_word : String,
) -> Frame raise Refuse {
  let (fa2, ak, atemp, _) = key_columns(
    ctx,
    prefix,
    "left",
    fa,
    pairs.map(fn(p) { p.l }),
  )
  let (fb2, bk, btemp, bnull) = key_columns(
    ctx,
    prefix,
    blabel,
    fb,
    pairs.map(fn(p) { p.r }),
  )
  let fb3 = right_prefilter(ctx, prefix, blabel, fb2, b_only, bk, bnull, pairs)
  let extra = [..a_only, ..residual]
  let nested = unique_col(col_names(fa2), blabel)
  ctx.comment(
    "Left join on " +
    key_text(fa2, ak, blabel, bk) +
    ": every " +
    side_word +
    "-side row is kept; it repeats once per matching " +
    blabel +
    " row, and unmatched rows get nulls.",
  )
  let merged_ref = if extra.length() == 0 && ak.length() > 0 {
    ctx.step(
      prefix,
      "Merged " + blabel,
      "Table.NestedJoin(" +
      fa2.ref_ +
      ", " +
      m_text_list(ak) +
      ", " +
      fb3.ref_ +
      ", " +
      m_text_list(bk) +
      ", " +
      m_text(nested) +
      ", JoinKind.LeftOuter)",
    )
  } else {
    matched_rows(ctx, prefix, fa2, ak, fb3, bk, blabel, nested, extra).ref_
  }
  let out = expand(
    ctx,
    prefix,
    blabel,
    merged_ref,
    fa2.cols,
    nested,
    fb3,
    btemp,
  )
  remove_cols(ctx, prefix, out, atemp)
}

///|
fn cross_join(
  ctx : Ctx,
  prefix : String,
  fl : Frame,
  fr : Frame,
  rlabel : String,
) -> Frame {
  let nested = unique_col(col_names(fl), rlabel)
  ctx.comment(
    "Cross join: every row paired with every " +
    rlabel +
    " row (row count multiplies).",
  )
  let added = ctx.step(
    prefix,
    "Added " + rlabel,
    "Table.AddColumn(" +
    fl.ref_ +
    ", " +
    m_text(nested) +
    ", each " +
    fr.ref_ +
    ")",
  )
  ctx.comment(
    "An empty nested table would expand to one row of nulls; SQL pairs nothing with an empty table.",
  )
  let nonempty = ctx.step(
    prefix,
    "Kept rows with " + rlabel,
    "Table.SelectRows(" +
    added +
    ", each not Table.IsEmpty([" +
    m_field(nested) +
    "]))",
  )
  expand(ctx, prefix, rlabel, nonempty, fl.cols, nested, fr, [])
}

// ---------------------------------------------------------------------------
// WHERE with subqueries

///|
fn is_subquery_cond(e : Expr) -> Bool {
  match e {
    InSub(_, _, _) | Exists(_) => true
    Not(x) => x is (InSub(_, _, _) | Exists(_))
    _ => false
  }
}

///|
fn not_in_refusal() -> String {
  "NOT IN (subquery) returns no rows at all when the subquery yields a NULL, a classic SQL trap. Write it as NOT EXISTS (...) or an ANTI JOIN, which say what you mean and translate directly."
}

///|
fn subquery_join(
  ctx : Ctx,
  prefix : String,
  frame : Frame,
  llabel : String,
  e : Expr,
) -> Frame raise Refuse {
  match e {
    InSub(x, q, false) => {
      let rel = compile_query(ctx, q, sub_prefix(prefix, "IN list"))
      if rel.cols.length() != 1 {
        raise Refuse("IN (subquery) must select exactly one column.")
      }
      let fr = frame_of(rel, "__in")
      join_frames(
        ctx,
        prefix,
        Semi,
        frame,
        llabel,
        fr,
        "IN list",
        Some(Cmp(Eq, x, Col(["__in", rel.cols[0].name]))),
        [],
        false,
        false,
      )
    }
    InSub(_, _, true) | Not(InSub(_, _, _)) => raise Refuse(not_in_refusal())
    Exists(q) | Not(Exists(q)) => {
      let node = match q {
        Select(n) => n
        _ => raise Refuse("EXISTS over a set operation is not supported.")
      }
      if node.ctes.length() > 0 ||
        node.group.length() > 0 ||
        node.having is Some(_) ||
        node.qualify is Some(_) ||
        node.mods.limit is Some(_) {
        raise Refuse(
          "EXISTS subqueries may only contain FROM and WHERE (no WITH, GROUP BY, HAVING, QUALIFY or LIMIT).",
        )
      }
      let label = ref_label(node.from)
      let fr = compile_from(ctx, node.from, sub_prefix(prefix, label))
      join_frames(
        ctx,
        prefix,
        if e is Exists(_) {
          Semi
        } else {
          Anti
        },
        frame,
        llabel,
        fr,
        label,
        node.where_,
        [],
        false,
        true,
      )
    }
    _ => raise Refuse("internal error: not a subquery condition")
  }
}

// ---------------------------------------------------------------------------
// SELECT

///|
fn children(e : Expr) -> Array[Expr] {
  match e {
    Col(_) | Const(_) | Star(_, _) | Exists(_) => []
    Func(_, args, _, filter) =>
      match filter {
        Some(f) => [..args, f]
        None => args
      }
    Cmp(_, a, b) => [a, b]
    And(ks) | Or(ks) | Coalesce(ks) => ks
    Not(a) | IsNull(a, _) | Cast(a, _, _) | InSub(a, _, _) => [a]
    InList(a, ks, _) => [a, ..ks]
    Between(a, b, c) => [a, b, c]
    Case(checks, other) => {
      let out = []
      for wt in checks {
        out.push(wt.0)
        out.push(wt.1)
      }
      out.push(other)
      out
    }
    Window(w) => {
      let out = [..w.args, ..w.partitions]
      for o in w.orders {
        out.push(o.expr)
      }
      if w.default_ is Some(d) {
        out.push(d)
      }
      out
    }
  }
}

///|
fn collect_aggs(e : Expr, acc : Array[Expr]) -> Unit {
  if is_aggregate(e) {
    if !acc.contains(e) {
      acc.push(e)
    }
    return
  }
  for c in children(e) {
    collect_aggs(c, acc)
  }
}

///|
fn default_name(e : Expr, i : Int) -> String {
  match e {
    Col(names) => names[names.length() - 1]
    Func("count_star", _, _, _) => "count_star()"
    Func(f, [Col(names)], _, _) if aggregate_names.contains(f) =>
      f + "(" + names[names.length() - 1] + ")"
    _ => "Column" + (i + 1).to_string()
  }
}

///|
priv struct OutCol {
  m : String
  out : String
  expr : Expr?
  ty : Ty
  notnull : Bool
}

///|
fn compile_select(
  ctx : Ctx,
  node : SelectNode,
  prefix : String,
) -> Rel raise Refuse {
  let llabel = ref_label(node.from)
  let mut frame = compile_from(ctx, node.from, prefix)
  if node.where_ is Some(w) {
    let plain = []
    let subs = []
    for c in split_and(w) {
      if is_subquery_cond(c) {
        subs.push(c)
      } else {
        plain.push(c)
      }
    }
    frame = filter_step(
      ctx,
      prefix,
      "Filtered Rows",
      frame,
      pred_texts(env1(frame), plain),
    )
    for s in subs {
      frame = subquery_join(ctx, prefix, frame, llabel, s)
    }
  }
  let aggs = []
  for it in node.items {
    collect_aggs(it.expr, aggs)
  }
  if node.having is Some(h) {
    collect_aggs(h, aggs)
  }
  if node.qualify is Some(q) {
    collect_aggs(q, aggs)
  }
  for o in node.mods.order {
    collect_aggs(o.expr, aggs)
  }
  let mut rewrite = []
  if node.group.length() > 0 || node.group_all || aggs.length() > 0 {
    let (f, rw) = compile_group(ctx, prefix, frame, node, aggs)
    frame = f
    rewrite = rw
    if node.having is Some(h) {
      let env = { frames: [(frame, "")], rewrite, prefer_last: false, }
      frame = filter_step(ctx, prefix, "Filtered Groups", frame, [
        wrap(pred(env, h, true), AND),
      ])
    }
  } else if node.having is Some(_) {
    raise Refuse("HAVING needs GROUP BY or an aggregate.")
  }
  // Window functions run after GROUP BY/HAVING, then QUALIFY filters on them.
  let wins = []
  for it in node.items {
    collect_windows(it.expr, wins)
  }
  if node.qualify is Some(q) {
    collect_windows(q, wins)
  }
  for o in node.mods.order {
    collect_windows(o.expr, wins)
  }
  if wins.length() > 0 {
    frame = compile_windows(ctx, prefix, frame, rewrite, wins, node.items)
  }
  if node.qualify is Some(q) {
    frame = qualify_step(ctx, prefix, frame, rewrite, q, node.items)
  }
  build_output(ctx, prefix, frame, rewrite, node.items, node.mods)
}

///|
fn compile_group(
  ctx : Ctx,
  prefix : String,
  frame0 : Frame,
  node : SelectNode,
  aggs : Array[Expr],
) -> (Frame, Array[(Expr, String, Ty)]) raise Refuse {
  let mut frame = frame0
  // GROUP BY targets: positions and select aliases resolve to select items.
  let targets : Array[Expr] = []
  if node.group_all {
    for it in node.items {
      if it.expr is Star(_, _) {
        raise Refuse("GROUP BY ALL with * is not supported; list the columns.")
      }
      let inner = []
      collect_aggs(it.expr, inner)
      if inner.length() == 0 {
        targets.push(it.expr)
      }
    }
  } else {
    for g in node.group {
      match g {
        Const(LNum(s)) =>
          match digits_value(s, 0, s.length()) {
            Some(k) if k >= 1 && k <= node.items.length() =>
              targets.push(node.items[k - 1].expr)
            _ => raise Refuse("GROUP BY \{s} is out of range.")
          }
        Col([name]) => {
          let resolves = try resolve(env1(frame), [name]) catch {
            _ => false
          } noraise {
            _ => true
          }
          if resolves {
            targets.push(g)
          } else {
            match
              node.items.search_by(fn(it) {
                it.as_name.to_lower() == name.to_lower()
              }) {
              Some(i) => targets.push(node.items[i].expr)
              None => targets.push(g)
            }
          }
        }
        _ => targets.push(g)
      }
    }
  }
  let rewrite : Array[(Expr, String, Ty)] = []
  let keys = []
  let key_cols = []
  for i, g in targets {
    match g {
      Col(names) => {
        let (_, c) = resolve(env1(frame), names)
        if !keys.contains(c.m) {
          keys.push(c.m)
          key_cols.push(c)
        }
      }
      _ => {
        let v = val(env1(frame), g)
        let as_name = match
          node.items.search_by(fn(it) { it.expr == g && it.as_name != "" }) {
          Some(j) => node.items[j].as_name
          None => "Group Key " + (i + 1).to_string()
        }
        let m = unique_col(col_names(frame), as_name)
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
        let fc = {
          qual: "",
          name: m,
          m,
          ty: v.ty,
          hidden: true,
          notnull: !v.nullable,
        }
        frame = { ref_, cols: [..frame.cols, fc], }
        keys.push(m)
        key_cols.push(fc)
        rewrite.push((g, m, v.ty))
      }
    }
  }
  // Aggregates: name, input column, M body builder.
  let taken = [..keys]
  let specs : Array[(String, (String) -> String raise Refuse, String, Ty, Bool)] = []
  for a in aggs {
    guard a is Func(fname, args, distinct, filter) else { continue }
    let as_name = match
      node.items.search_by(fn(it) { it.expr == a && it.as_name != "" }) {
      Some(j) => node.items[j].as_name
      None => default_name(a, specs.length())
    }
    let m = unique_col(taken, as_name)
    taken.push(m)
    let mut input = ""
    let mut input_ty = TAny
    if fname != "count_star" && args.length() > 0 {
      match args[0] {
        Col(names) => {
          let (_, c) = resolve(env1(frame), names)
          input = c.m
          input_ty = c.ty
        }
        arg => {
          let v = val(env1(frame), arg)
          let im = unique_col(col_names(frame), m + " input")
          let ref_ = ctx.step(
            prefix,
            "Added " + im,
            "Table.AddColumn(" +
            frame.ref_ +
            ", " +
            m_text(im) +
            ", each " +
            v.text +
            type_arg(v.ty) +
            ")",
          )
          frame = {
            ref_,
            cols: [
              ..frame.cols,
              {
                qual: "",
                name: im,
                m: im,
                ty: v.ty,
                hidden: true,
                notnull: !v.nullable,
              },
            ],
          }
          input = im
          input_ty = v.ty
        }
      }
    }
    let filter_text = match filter {
      Some(f) => Some(pred(env1(frame), f, true).text)
      None => None
    }
    let sep = if args.length() >= 2 {
      match args[1] {
        Const(LText(s)) => m_text(s)
        _ => raise Refuse("\{fname}() separator must be a literal.")
      }
    } else {
      m_text(",")
    }
    let input_col = input
    let in_ty = input_ty
    let body = fn(g : String) raise Refuse {
      let tbl = match filter_text {
        Some(p) => "Table.SelectRows(" + g + ", each " + p + ")"
        None => g
      }
      let list = if tbl == "_" {
        "[" + m_field(input_col) + "]"
      } else {
        tbl + "[" + m_field(input_col) + "]"
      }
      let dl = if distinct { "List.Distinct(" + list + ")" } else { list }
      match fname {
        "count_star" => "Table.RowCount(" + tbl + ")"
        "count" =>
          if args.length() == 0 {
            "Table.RowCount(" + tbl + ")"
          } else {
            "List.NonNullCount(" + dl + ")"
          }
        "sum" => "List.Sum(" + dl + ")"
        "avg" | "mean" => "List.Average(" + dl + ")"
        "min" => "List.Min(" + list + ")"
        "max" => "List.Max(" + list + ")"
        "string_agg" | "group_concat" | "listagg" => {
          let items = if in_ty == TText {
            dl
          } else {
            "List.Transform(" + dl + ", each Text.From(_, \"en-US\"))"
          }
          "Text.Combine(" + items + ", " + sep + ")"
        }
        "any_value" => "List.First(List.RemoveNulls(" + list + "))"
        other => raise Refuse("Aggregate \{other}() is not supported.")
      }
    }
    let (ty, ty_text, notnull) = match fname {
      "count_star" | "count" => (TNum, "Int64.Type", true)
      "sum" | "avg" | "mean" => (TNum, "type number", false)
      "string_agg" | "group_concat" | "listagg" => (TText, "type text", false)
      _ => (input_ty, type_arg(input_ty).replace(old=", ", new=""), false)
    }
    specs.push((m, body, ty_text, ty, notnull))
    rewrite.push((a, m, ty))
  }
  let agg_cols = specs.map(fn(s) {
    { qual: "", name: s.0, m: s.0, ty: s.3, hidden: true, notnull: s.4, }
  })
  let ref_ = if keys.length() > 0 {
    let parts = []
    for s in specs {
      let t = if s.2 == "" { "" } else { ", " + s.2 }
      parts.push("{" + m_text(s.0) + ", each " + (s.1)("_") + t + "}")
    }
    ctx.step(
      prefix,
      "Grouped Rows",
      "Table.Group(" +
      frame.ref_ +
      ", " +
      m_text_list(keys) +
      ", " +
      m_list(parts) +
      ")",
    )
  } else {
    let values = []
    for s in specs {
      values.push((s.1)(frame.ref_))
    }
    ctx.comment(
      "Aggregate without GROUP BY: always exactly one row, as in SQL.",
    )
    ctx.step(
      prefix,
      "Aggregated",
      "#table(" +
      m_text_list(specs.map(fn(s) { s.0 })) +
      ", {" +
      m_list(values) +
      "})",
    )
  }
  ({ ref_, cols: [..key_cols, ..agg_cols], }, rewrite)
}

///|
fn int_literal(e : Expr, what : String) -> String raise Refuse {
  match e {
    Const(LNum(s)) if digits_value(s, 0, s.length()) is Some(_) => s
    _ => raise Refuse("\{what} must be a whole-number literal.")
  }
}

///|
/// Table.Sort criteria for (column, descending, nulls first, nullable) keys.
fn sort_criteria(keys : Array[(String, Bool, Bool, Bool)]) -> Array[String] {
  let crits = []
  for k in keys {
    let (m, desc, nulls_first, nullable) = k
    let order = if desc { "Order.Descending" } else { "Order.Ascending" }
    // Power Query sorts null lowest; DuckDB defaults to NULLS LAST.
    let natural_nulls_first = !desc
    if nullable && natural_nulls_first != nulls_first {
      let null_order = if nulls_first {
        "Order.Descending"
      } else {
        "Order.Ascending"
      }
      crits.push("{each [" + m_field(m) + "] = null, " + null_order + "}")
    }
    crits.push("{" + m_text(m) + ", " + order + "}")
  }
  crits
}

///|
fn sort_step(
  ctx : Ctx,
  prefix : String,
  ref_ : String,
  keys : Array[(String, Bool, Bool, Bool)],
) -> String {
  ctx.step(
    prefix,
    "Sorted Rows",
    "Table.Sort(" + ref_ + ", " + m_list(sort_criteria(keys)) + ")",
  )
}

///|
fn build_output(
  ctx : Ctx,
  prefix : String,
  frame0 : Frame,
  rewrite : Array[(Expr, String, Ty)],
  items : Array[SelectItem],
  mods : Mods,
) -> Rel raise Refuse {
  let mut frame = frame0
  let env = fn(f : Frame) -> Env {
    { frames: [(f, "")], rewrite, prefer_last: false, }
  }
  let outs : Array[OutCol] = []
  for i, item in items {
    match item.expr {
      Star(rel, excl) => {
        let q = rel.to_lower()
        let mut any = false
        for c in frame.cols {
          if c.hidden || (q != "" && c.qual != q) {
            continue
          }
          any = true
          if excl.iter().any(fn(x) { x.to_lower() == c.name.to_lower() }) {
            continue
          }
          outs.push({
            m: c.m,
            out: c.name,
            expr: Some(Col([c.qual, c.name])),
            ty: c.ty,
            notnull: c.notnull,
          })
        }
        if !any {
          raise Refuse(
            if q == "" {
              "SELECT * has no columns here."
            } else {
              "Unknown table alias \{rel} in \{rel}.*."
            },
          )
        }
      }
      e => {
        let out_name = if item.as_name != "" {
          item.as_name
        } else {
          default_name(e, i)
        }
        let found = rewrite.search_by(fn(r) { r.0 == e })
        match (found, e) {
          (Some(j), _) =>
            outs.push({
              m: rewrite[j].1,
              out: out_name,
              expr: Some(e),
              ty: rewrite[j].2,
              notnull: false,
            })
          (None, Col(names)) => {
            let (_, c) = resolve(env(frame), names)
            outs.push({
              m: c.m,
              out: out_name,
              expr: Some(e),
              ty: c.ty,
              notnull: c.notnull,
            })
          }
          _ => {
            let v = val(env(frame), e)
            let m = unique_col(col_names(frame), out_name)
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
            frame = {
              ref_,
              cols: [
                ..frame.cols,
                {
                  qual: "",
                  name: m,
                  m,
                  ty: v.ty,
                  hidden: true,
                  notnull: !v.nullable,
                },
              ],
            }
            outs.push({
              m,
              out: out_name,
              expr: Some(e),
              ty: v.ty,
              notnull: !v.nullable,
            })
          }
        }
      }
    }
  }
  // Resolve an ORDER BY term to a column: position, output alias, selected
  // expression, or (without DISTINCT) any expression over the input.
  let order_col = fn(o : OrderItem, allow_new : Bool) raise Refuse {
    match o.expr {
      Const(LNum(s)) =>
        match digits_value(s, 0, s.length()) {
          Some(k) if k >= 1 && k <= outs.length() =>
            return (outs[k - 1].m, !outs[k - 1].notnull)
          _ => raise Refuse("ORDER BY \{s} is out of range.")
        }
      Col([name]) =>
        match outs.search_by(fn(oc) { oc.out.to_lower() == name.to_lower() }) {
          Some(j) => return (outs[j].m, !outs[j].notnull)
          None => ()
        }
      _ => ()
    }
    match outs.search_by(fn(oc) { oc.expr == Some(o.expr) }) {
      Some(j) => return (outs[j].m, !outs[j].notnull)
      None => ()
    }
    if !allow_new {
      raise Refuse("With DISTINCT, ORDER BY must use selected columns.")
    }
    match rewrite.search_by(fn(r) { r.0 == o.expr }) {
      Some(j) => return (rewrite[j].1, true)
      None => ()
    }
    match o.expr {
      Col(names) => {
        let (_, c) = resolve(env(frame), names)
        (c.m, !c.notnull)
      }
      e => {
        let v = val(env(frame), e)
        let m = unique_col(col_names(frame), "Sort Key")
        let ref_ = ctx.step(
          prefix,
          "Added " + m,
          "Table.AddColumn(" +
          frame.ref_ +
          ", " +
          m_text(m) +
          ", each " +
          v.text +
          ")",
        )
        frame = {
          ref_,
          cols: [
            ..frame.cols,
            { qual: "", name: m, m, ty: v.ty, hidden: true, notnull: false, },
          ],
        }
        (m, v.nullable)
      }
    }
  }
  if !mods.distinct && mods.order.length() > 0 {
    let keys = []
    for o in mods.order {
      let (m, nullable) = order_col(o, true)
      keys.push((m, o.desc, o.nulls_first, nullable))
    }
    frame = with_ref(frame, sort_step(ctx, prefix, frame.ref_, keys))
  }
  // Project: unique output names, duplicate selections copied.
  let used_out = []
  let used_m = []
  let final_ = []
  for oc in outs {
    let mut name = oc.out
    if used_out.contains(name) {
      name = if oc.m != oc.out &&
        !used_out.contains(oc.m) &&
        !outs.iter().any(fn(x) { x.out == oc.m }) {
        oc.m
      } else {
        unique_col(used_out, oc.out)
      }
    }
    used_out.push(name)
    let mut m = oc.m
    if used_m.contains(m) {
      let copy = unique_col([..col_names(frame), ..used_m], name)
      let ref_ = ctx.step(
        prefix,
        "Duplicated " + oc.m,
        "Table.DuplicateColumn(" +
        frame.ref_ +
        ", " +
        m_text(oc.m) +
        ", " +
        m_text(copy) +
        ")",
      )
      frame = {
        ref_,
        cols: [
          ..frame.cols,
          {
            qual: "",
            name: copy,
            m: copy,
            ty: oc.ty,
            hidden: true,
            notnull: oc.notnull,
          },
        ],
      }
      m = copy
    }
    used_m.push(m)
    final_.push({ ..oc, m, out: name, })
  }
  let ms = final_.map(fn(o) { o.m })
  let mut ref_ = frame.ref_
  if ms != col_names(frame) {
    ref_ = ctx.step(
      prefix,
      "Selected Columns",
      "Table.SelectColumns(" + ref_ + ", " + m_text_list(ms) + ")",
    )
  }
  let renames = []
  for o in final_ {
    if o.m != o.out {
      renames.push(m_text_list([o.m, o.out]))
    }
  }
  if renames.length() > 0 {
    ref_ = ctx.step(
      prefix,
      "Renamed Columns",
      "Table.RenameColumns(" + ref_ + ", " + m_list(renames) + ")",
    )
  }
  if mods.distinct {
    ref_ = ctx.step(
      prefix,
      "Removed Duplicates",
      "Table.Distinct(" + ref_ + ")",
    )
    if mods.order.length() > 0 {
      let keys = []
      for o in mods.order {
        let (m, nullable) = order_col(o, false)
        let j = final_.search_by(fn(f) { f.m == m }).unwrap()
        keys.push((final_[j].out, o.desc, o.nulls_first, nullable))
      }
      ref_ = sort_step(ctx, prefix, ref_, keys)
    }
  }
  ref_ = limit_steps(ctx, prefix, ref_, mods)
  {
    ref_,
    cols: final_.map(fn(o) { { name: o.out, ty: o.ty, notnull: o.notnull, } }),
  }
}

///|
fn limit_steps(
  ctx : Ctx,
  prefix : String,
  ref0 : String,
  mods : Mods,
) -> String raise Refuse {
  let mut ref_ = ref0
  if mods.offset is Some(off) {
    ref_ = ctx.step(
      prefix,
      "Skipped Rows",
      "Table.Skip(" + ref_ + ", " + int_literal(off, "OFFSET") + ")",
    )
  }
  if mods.limit is Some(l) {
    ref_ = ctx.step(
      prefix,
      "Kept First Rows",
      "Table.FirstN(" + ref_ + ", " + int_literal(l, "LIMIT") + ")",
    )
  }
  ref_
}

// ---------------------------------------------------------------------------
// Set operations

///|
fn flatten_setop(
  q : Query,
  kind : SetKind,
  all : Bool,
  out : Array[Query],
) -> Unit {
  match q {
    SetOp(k, a, l, r, ctes, mods) if k == kind &&
      a == all &&
      ctes.length() == 0 &&
      mods.order.length() == 0 &&
      mods.limit is None &&
      mods.offset is None &&
      (kind == Union || kind == UnionByName) => {
      flatten_setop(l, kind, all, out)
      flatten_setop(r, kind, all, out)
    }
    _ => out.push(q)
  }
}

///|
fn compile_setop(ctx : Ctx, q : Query, prefix : String) -> Rel raise Refuse {
  guard q is SetOp(kind, all, l, r, _, mods) else {
    raise Refuse("internal error: not a set operation")
  }
  let parts = []
  if kind == Union || kind == UnionByName {
    flatten_setop(l, kind, all, parts)
    flatten_setop(r, kind, all, parts)
  } else {
    parts.push(l)
    parts.push(r)
  }
  let rels = []
  for i, p in parts {
    rels.push(
      compile_query(ctx, p, sub_prefix(prefix, "Part " + (i + 1).to_string())),
    )
  }
  let cols = rels[0].cols
  let refs = [rels[0].ref_]
  let mut out_cols = cols
  if kind == UnionByName {
    for i = 1; i < rels.length(); i = i + 1 {
      refs.push(rels[i].ref_)
      for c in rels[i].cols {
        if !out_cols.iter().any(fn(d) { d.name == c.name }) {
          out_cols = [..out_cols, c]
        }
      }
    }
  } else {
    for i = 1; i < rels.length(); i = i + 1 {
      let rel = rels[i]
      if rel.cols.length() != cols.length() {
        raise Refuse(
          "Set operation inputs have different column counts (\{cols.length()} vs \{rel.cols.length()}).",
        )
      }
      let renames = []
      for j, c in rel.cols {
        if c.name != cols[j].name {
          renames.push(m_text_list([c.name, cols[j].name]))
        }
      }
      if renames.length() > 0 {
        refs.push(
          ctx.step(
            sub_prefix(prefix, "Part " + (i + 1).to_string()),
            "Renamed Columns",
            "Table.RenameColumns(" + rel.ref_ + ", " + m_list(renames) + ")",
          ),
        )
      } else {
        refs.push(rel.ref_)
      }
    }
  }
  let names = cols.map(fn(c) { c.name })
  let mut ref_ = match kind {
    Union | UnionByName => {
      let combined = ctx.step(
        prefix,
        "Appended Queries",
        "Table.Combine(" + m_list(refs) + ")",
      )
      if all {
        combined
      } else {
        ctx.step(
          prefix,
          "Removed Duplicates",
          "Table.Distinct(" + combined + ")",
        )
      }
    }
    Except | Intersect => {
      let except = kind == Except
      ctx.comment(
        (if except { "EXCEPT" } else { "INTERSECT" }) +
        " compares whole rows; NULLs count as equal here, as in SQL set operations.",
      )
      let merged = ctx.step(
        prefix,
        if except {
          "Removed Matching Rows"
        } else {
          "Kept Matching Rows"
        },
        "Table.NestedJoin(" +
        refs[0] +
        ", " +
        m_text_list(names) +
        ", " +
        refs[1] +
        ", " +
        m_text_list(names) +
        ", \"Matches\", " +
        (if except { "JoinKind.LeftAnti" } else { "JoinKind.Inner" }) +
        ")",
      )
      let removed = ctx.step(
        prefix,
        "Removed Columns",
        "Table.RemoveColumns(" + merged + ", {\"Matches\"})",
      )
      ctx.step(prefix, "Removed Duplicates", "Table.Distinct(" + removed + ")")
    }
  }
  if mods.order.length() > 0 {
    let keys = []
    for o in mods.order {
      let name = match o.expr {
        Const(LNum(s)) =>
          match digits_value(s, 0, s.length()) {
            Some(k) if k >= 1 && k <= out_cols.length() => out_cols[k - 1].name
            _ => raise Refuse("ORDER BY \{s} is out of range.")
          }
        Col(n) =>
          match
            out_cols.search_by(fn(c) {
              c.name.to_lower() == n[n.length() - 1].to_lower()
            }) {
            Some(j) => out_cols[j].name
            None =>
              raise Refuse(
                "ORDER BY after UNION/EXCEPT/INTERSECT must name an output column.",
              )
          }
        _ =>
          raise Refuse(
            "ORDER BY after UNION/EXCEPT/INTERSECT must name an output column.",
          )
      }
      keys.push((name, o.desc, o.nulls_first, true))
    }
    ref_ = sort_step(ctx, prefix, ref_, keys)
  }
  ref_ = limit_steps(ctx, prefix, ref_, mods)
  { ref_, cols: out_cols, }
}
