import test from "node:test";
import assert from "node:assert/strict";
import {
  addTransport, addDay, addPlace, createTrip, getTrip, deletePlace,
  movePlace, openTravelDB, setPreferredTransport, updateTransport, deleteTransport,
} from "../src/lib/travel/db.ts";

test("transport options bind to place pairs, survive reorder, cascade on delete", () => {
  const db = openTravelDB();
  try {
    const tripId = createTrip(db, { title: "交通行程", startDate: "2026-11-01" });
    const dayId = getTrip(db, tripId)!.days[0].id;
    const a = addPlace(db, tripId, dayId, "A");
    const b = addPlace(db, tripId, dayId, "B");
    const c = addPlace(db, tripId, dayId, "C");

    const t1 = addTransport(db, tripId, a, b, { mode: "地铁", duration: "25 分钟", cost: "8", note: "2号线", preferred: true });
    addTransport(db, tripId, a, b, { mode: "打车", duration: "15 分钟", cost: "35" });
    addTransport(db, tripId, b, c, { mode: "步行", duration: "40 分钟" });
    let t = getTrip(db, tripId)!;
    assert.equal(t.transports.length, 3);
    assert.equal(t.transports.filter((x) => x.fromPlaceId === a && x.toPlaceId === b).length, 2);
    assert.ok(t.transports.find((x) => x.id === t1)!.preferred, "first marked preferred");

    // 重排/移动地点不影响已存方案（按起终点绑定）
    movePlace(db, b, null);
    t = getTrip(db, tripId)!;
    assert.equal(t.transports.length, 3, "reorder does not delete options");
    assert.equal(t.days[0].places.length, 2);

    // 设为首选：同段唯一
    const options = t.transports.filter((x) => x.fromPlaceId === a && x.toPlaceId === b);
    setPreferredTransport(db, options[1].id);
    t = getTrip(db, tripId)!;
    assert.equal(t.transports.filter((x) => x.fromPlaceId === a && x.toPlaceId === b && x.preferred).length, 1);
    assert.equal(t.transports.find((x) => x.id === options[1].id)!.preferred, true);

    // 编辑与删除
    updateTransport(db, options[1].id, { mode: "网约车", cost: "38", note: "夜间加价" });
    t = getTrip(db, tripId)!;
    const edited = t.transports.find((x) => x.id === options[1].id)!;
    assert.equal(edited.mode, "网约车");
    assert.equal(edited.preferred, true, "edit keeps preferred");
    assert.throws(() => updateTransport(db, options[1].id, { mode: "" }), /不能为空/);
    deleteTransport(db, options[1].id);
    assert.equal(getTrip(db, tripId)!.transports.length, 2);

    // 校验：同点/跨行程/超限
    assert.throws(() => addTransport(db, tripId, a, a, { mode: "原地" }), /同一个/);
    const otherTrip = createTrip(db, { title: "其他" });
    assert.throws(() => addTransport(db, otherTrip, a, b, { mode: "瞬移" }), /不属于/);
    for (let i = 0; i < 5; i += 1) addTransport(db, tripId, a, b, { mode: `方案${i}` });
    assert.throws(() => addTransport(db, tripId, a, b, { mode: "第七种" }), /最多 6/);
    assert.equal(getTrip(db, tripId)!.transports.filter((x) => x.fromPlaceId === a && x.toPlaceId === b).length, 6);

    // 删除地点：其相关交通方案级联清理
    deletePlace(db, a);
    t = getTrip(db, tripId)!;
    assert.equal(t.transports.length, 1, "only b→c remains");
    assert.equal(t.transports[0].fromPlaceId, b);
    assert.equal(t.transports[0].toPlaceId, c);
  } finally { db.close(); }
});
