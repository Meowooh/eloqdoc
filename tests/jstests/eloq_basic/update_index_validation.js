// Updates must preserve index consistency and the exact BSON type of index keys.
(function() {
    "use strict";

    const indexNames = ["_id_", "stable_1", "value_1"];
    const testCases = [
        {name: "int control", suffix: "int", id: NumberInt(101)},
        {name: "long", suffix: "long", id: NumberLong("102")},
        {name: "integral double", suffix: "double", id: 103.0},
        {name: "decimal", suffix: "decimal", id: NumberDecimal("104.0")},
        {name: "negative double zero", suffix: "negative_double_zero", id: -0.0},
        {name: "decimal zero", suffix: "decimal_zero", id: NumberDecimal("-0E3")},
        {
            name: "embedded long",
            suffix: "embedded_long",
            id: {kind: "embedded", sequence: NumberLong("105")},
        },
    ];

    function assertSingleReturnedKey(coll, query, indexName, expectedKey, context) {
        const keys = coll.find(query).hint(indexName).returnKey().toArray();
        assert.eq(1, keys.length, context + ": " + tojson(keys));
        assert(bsonBinaryEqual(expectedKey, keys[0]),
               context + ": expected " + tojson(expectedKey) + ", got " + tojson(keys[0]));
    }

    function assertFullValidation(coll, stage) {
        const result = coll.validate({full: true});
        assert.commandWorked(result);
        assert(result.valid, stage + ": " + tojson(result));
        assert.eq(indexNames.length, result.nIndexes, stage + ": " + tojson(result));

        indexNames.forEach(function(indexName) {
            const detailName = coll.getFullName() + ".$" + indexName;
            assert(result.indexDetails[detailName].valid,
                   stage + ": " + indexName + " is invalid: " + tojson(result));
        });
    }

    testCases.forEach(function(testCase) {
        const coll = db.getCollection("update_index_validation_" + testCase.suffix);
        const context = testCase.name;

        coll.drop();
        assert.commandWorked(coll.createIndex({stable: 1}, {name: "stable_1"}));
        assert.commandWorked(coll.createIndex({value: 1}, {name: "value_1"}));
        assert.writeOK(coll.insert({_id: testCase.id, stable: "unchanged", value: 10.0}));

        assertFullValidation(coll, context + " after insert");
        assertSingleReturnedKey(
            coll, {_id: testCase.id}, "_id_", {_id: testCase.id}, context + " after insert");

        assert.writeOK(coll.update({_id: testCase.id}, {$set: {value: 20.0}}));
        assert.eq(20.0, coll.findOne({_id: testCase.id}).value, context);
        assert.eq(0,
                  coll.find({value: 10.0}).hint("value_1").itcount(),
                  context + ": stale value index key");
        assert.eq(1,
                  coll.find({value: 20.0}).hint("value_1").itcount(),
                  context + ": missing value index key");
        assert.eq(1,
                  coll.find({stable: "unchanged"}).hint("stable_1").itcount(),
                  context + ": missing unchanged index key");

        assertFullValidation(coll, context + " after update");
        assertSingleReturnedKey(
            coll, {_id: testCase.id}, "_id_", {_id: testCase.id}, context + " after update");
        assertSingleReturnedKey(coll,
                                {stable: "unchanged"},
                                "stable_1",
                                {stable: "unchanged"},
                                context + " unchanged secondary index");
        assertSingleReturnedKey(coll,
                                {value: 20.0},
                                "value_1",
                                {value: 20.0},
                                context + " updated secondary index");
    });
})();
