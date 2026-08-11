/**
 * Stresses multikey metadata commits while Eloq catalog entries are repeatedly refreshed and
 * destroyed. The test only observes behavior through MongoDB commands and explain output.
 *
 * Run a larger stress pass against an existing server with:
 *
 *   eloqdoc-cli --quiet --eval '
 *       var MultikeyCatalogCommitStressOptions = {
 *           workerCount: 8,
 *           iterations: 20,
 *           dbPrefix: "multikey_catalog_commit_stress_high",
 *           keepCanary: true
 *       };
 *       load("tests/jstests/eloq_basic/multikey_catalog_commit_stress.js");'
 *
 * After restarting the server, verify and remove the persistent canary with:
 *
 *   eloqdoc-cli --quiet --eval '
 *       var MultikeyCatalogCommitStressOptions = {
 *           dbPrefix: "multikey_catalog_commit_stress_high",
 *           verifyOnly: true,
 *           cleanupAfterVerify: true
 *       };
 *       load("tests/jstests/eloq_basic/multikey_catalog_commit_stress.js");'
 */
(function() {
    "use strict";

    load("tests/jstests/libs/parallelTester.js");  // For ScopedThread.

    const suppliedOptions = (typeof MultikeyCatalogCommitStressOptions === "object")
        ? MultikeyCatalogCommitStressOptions
        : {};

    function optionOrDefault(name, defaultValue) {
        return suppliedOptions.hasOwnProperty(name) ? suppliedOptions[name] : defaultValue;
    }

    const workerCount = optionOrDefault("workerCount", 4);
    const iterations = optionOrDefault("iterations", 20);
    const dbPrefix = optionOrDefault("dbPrefix", "multikey_catalog_commit_stress");
    const checkpointEvery = optionOrDefault("checkpointEvery", 5);
    const keepCanary = optionOrDefault("keepCanary", false);
    const verifyOnly = optionOrDefault("verifyOnly", false);
    const cleanupAfterVerify = optionOrDefault("cleanupAfterVerify", false);
    const host = db.getMongo().host;
    const canaryDBName = dbPrefix + "_canary";

    const helpers = {
        counterNames: [
            "directInserts",
            "directUpdates",
            "transactionCommits",
            "transactionAborts",
            "buildOnExistingArrays",
            "failedWritesRolledBack",
            "checkpointChecks",
            "collectionDrops",
            "databaseDrops"
        ],

        scenarios: [
            "directInsert",
            "directUpdate",
            "transactionCommit",
            "transactionAbort",
            "buildOnExistingArrays"
        ],

        findIndexScan: function(plan) {
            if (!plan) {
                return null;
            }
            if (plan.stage === "IXSCAN") {
                return plan;
            }
            if (plan.inputStage) {
                const inputResult = this.findIndexScan(plan.inputStage);
                if (inputResult) {
                    return inputResult;
                }
            }
            if (plan.inputStages) {
                for (let i = 0; i < plan.inputStages.length; ++i) {
                    const inputResult = this.findIndexScan(plan.inputStages[i]);
                    if (inputResult) {
                        return inputResult;
                    }
                }
            }
            return null;
        },

        getIndexScan: function(coll, indexName) {
            const explain = coll.find().hint(indexName).explain();
            assert.commandWorked(explain);
            const indexScan = this.findIndexScan(explain.queryPlanner.winningPlan);
            assert.neq(null, indexScan, tojson(explain));
            assert.eq(indexName, indexScan.indexName, tojson(indexScan));
            return indexScan;
        },

        assertIndexMetadata: function(coll, expectedMultikey) {
            const expected = expectedMultikey
                ? {
                      aOnly: {"a.b": ["a"]},
                      tags: {tags: ["tags"]},
                      nested: {"x.y": ["x.y"]},
                      compound: {"a.b": ["a"], "c.d": ["c"]}
                  }
                : {
                      aOnly: {"a.b": []},
                      tags: {tags: []},
                      nested: {"x.y": []},
                      compound: {"a.b": [], "c.d": []}
                  };
            const helpers = this;

            Object.keys(expected).forEach(function(indexName) {
                const indexScan = helpers.getIndexScan(coll, indexName);
                assert.eq(expectedMultikey, indexScan.isMultiKey, tojson(indexScan));
                assert.docEq(expected[indexName], indexScan.multiKeyPaths, tojson(indexScan));
            });
        },

        createIndexes: function(database, collName) {
            assert.commandWorked(database.runCommand({
                createIndexes: collName,
                indexes: [
                    {key: {"a.b": 1}, name: "aOnly"},
                    {key: {tags: 1}, name: "tags"},
                    {key: {"x.y": 1}, name: "nested"},
                    {key: {"a.b": 1, "c.d": 1}, name: "compound"}
                ]
            }));
        },

        scalarDocument: function(id, base) {
            return {
                _id: id,
                a: {b: base},
                c: {d: base},
                tags: base,
                x: {y: base}
            };
        },

        arrayDocument: function(id, base) {
            return {
                _id: id,
                a: [{b: base + 1}, {b: base + 2}],
                c: {d: base + 1},
                tags: [base + 1, base + 2],
                x: {y: [base + 1, base + 2]}
            };
        },

        secondPathDocument: function(id, base) {
            return {
                _id: id,
                a: {b: base + 3},
                c: [{d: base + 3}, {d: base + 4}],
                tags: base + 3,
                x: {y: base + 3}
            };
        },

        assertHealthyMultikeyQueries: function(coll, base) {
            assert.eq(1, coll.find({"a.b": base + 2}).hint("aOnly").itcount());
            assert.eq(1, coll.find({"c.d": base + 4}).hint("compound").itcount());
            assert.eq(1, coll.find({tags: base + 2}).hint("tags").itcount());
            assert.eq(1, coll.find({"x.y": base + 2}).hint("nested").itcount());
            assert.eq(1, coll.find({"a.b": base + 2}).itcount());
            this.assertIndexMetadata(coll, true);
        }
    };

    function assertCanary(database) {
        const coll = database.canary;
        assert.eq(2, coll.count(), "persistent canary documents are missing");
        helpers.assertHealthyMultikeyQueries(coll, 7000);

        assert.eq(5, coll.getIndexes().length, tojson(coll.getIndexes()));
    }

    function createCanary(database) {
        // Eloq may retain an empty collection schema across a server restart when only
        // dropDatabase() is used. Drop the collection explicitly so repeated runs start clean.
        database.canary.drop();
        assert.commandWorked(database.dropDatabase());
        assert.commandWorked(database.canary.insert(helpers.scalarDocument(0, 7000)));
        helpers.createIndexes(database, "canary");
        helpers.assertIndexMetadata(database.canary, false);

        const session = database.getMongo().startSession({causalConsistency: false});
        const sessionDB = session.getDatabase(database.getName());
        session.startTransaction();
        assert.writeOK(sessionDB.canary.update({_id: 0}, helpers.arrayDocument(0, 7000)));
        assert.writeOK(sessionDB.canary.insert(helpers.secondPathDocument(1, 7000)));
        assert.eq(1, sessionDB.canary.find({"a.b": 7002}).hint("aOnly").itcount());
        assert.eq(1, sessionDB.canary.find({"c.d": 7004}).hint("compound").itcount());
        assert.commandWorked(session.commitTransaction_forTesting());
        session.endSession();

        assertCanary(database);
    }

    if (verifyOnly) {
        const canaryDB = db.getSiblingDB(canaryDBName);
        assertCanary(canaryDB);
        if (cleanupAfterVerify) {
            assert.eq(true, canaryDB.canary.drop());
            assert.commandWorked(canaryDB.dropDatabase());
        }
        print("MULTIKEY_CATALOG_COMMIT_STRESS_VERIFY_OK " +
              tojsononeline({dbPrefix: dbPrefix, cleanupAfterVerify: cleanupAfterVerify}));
        return;
    }

    function stressWorker(helpers, host, dbPrefix, workerId, iterations, checkpointEvery) {
        const connection = new Mongo(host);
        const workerDB = connection.getDB(dbPrefix + "_w" + workerId);
        const collName = "catalog_churn";
        const stats = {
            workerId: workerId,
            iterations: iterations
        };
        helpers.counterNames.forEach(function(counterName) {
            stats[counterName] = 0;
        });

        workerDB.getCollection(collName).drop();
        assert.commandWorked(workerDB.dropDatabase());
        ++stats.databaseDrops;

        for (let round = 0; round < iterations; ++round) {
            const coll = workerDB.getCollection(collName);
            const base = workerId * 100000000 + round * 100;
            const scenario = helpers.scenarios[round % helpers.scenarios.length];

            if (scenario === "buildOnExistingArrays") {
                assert.writeOK(coll.insert(helpers.arrayDocument(1, base)));
                assert.writeOK(coll.insert(helpers.secondPathDocument(2, base)));
                helpers.createIndexes(workerDB, collName);
                helpers.assertHealthyMultikeyQueries(coll, base);
                ++stats.buildOnExistingArrays;
            } else {
                assert.writeOK(coll.insert(helpers.scalarDocument(0, base)));
                helpers.createIndexes(workerDB, collName);
                helpers.assertIndexMetadata(coll, false);

                // Exercise a cached scalar query shape before the index becomes multikey.
                for (let warmup = 0; warmup < 3; ++warmup) {
                    assert.eq(1, coll.find({"a.b": base}).itcount());
                }

                if (scenario === "directInsert") {
                    assert.writeOK(coll.insert(helpers.arrayDocument(1, base)));
                    assert.writeOK(coll.insert(helpers.secondPathDocument(2, base)));
                    ++stats.directInserts;
                } else if (scenario === "directUpdate") {
                    assert.writeOK(coll.update({_id: 0}, helpers.arrayDocument(0, base)));
                    assert.writeOK(coll.insert(helpers.secondPathDocument(2, base)));
                    ++stats.directUpdates;
                } else {
                    const session = connection.startSession({causalConsistency: false});
                    const sessionDB = session.getDatabase(workerDB.getName());
                    const sessionColl = sessionDB.getCollection(collName);
                    session.startTransaction();
                    assert.writeOK(
                        sessionColl.update({_id: 0}, helpers.arrayDocument(0, base)));
                    assert.writeOK(sessionColl.insert(helpers.secondPathDocument(2, base)));
                    assert.eq(1,
                              sessionColl.find({"a.b": base + 2}).hint("aOnly").itcount());
                    assert.eq(1,
                              sessionColl.find({"c.d": base + 4}).hint("compound").itcount());

                    if (scenario === "transactionCommit") {
                        assert.commandWorked(session.commitTransaction_forTesting());
                        ++stats.transactionCommits;
                    } else {
                        assert.commandWorked(session.abortTransaction_forTesting());
                        ++stats.transactionAborts;
                    }
                    session.endSession();

                    if (scenario === "transactionAbort") {
                        assert.eq(0, coll.find({"a.b": base + 2}).itcount());
                        assert.eq(0, coll.find({"c.d": base + 4}).itcount());
                        helpers.assertIndexMetadata(coll, false);

                        // The first three indexes see arrays before the compound index rejects the
                        // parallel arrays. The entire failed write must roll back their metadata.
                        const failedWrite = coll.insert({
                            _id: 99,
                            a: [{b: base + 10}, {b: base + 11}],
                            c: [{d: base + 10}, {d: base + 11}],
                            tags: [base + 10, base + 11],
                            x: {y: [base + 10, base + 11]}
                        });
                        assert.writeErrorWithCode(
                            failedWrite, ErrorCodes.CannotIndexParallelArrays, tojson(failedWrite));
                        helpers.assertIndexMetadata(coll, false);
                        ++stats.failedWritesRolledBack;

                        assert.writeOK(coll.update({_id: 0}, helpers.arrayDocument(0, base)));
                        assert.writeOK(coll.insert(helpers.secondPathDocument(2, base)));
                    }
                }

                helpers.assertHealthyMultikeyQueries(coll, base);
            }

            if ((round + 1) % checkpointEvery === 0 || round + 1 === iterations) {
                assert.eq(scenario === "directInsert" ? 3 : 2, coll.find().itcount());
                assert.eq(5, coll.getIndexes().length, tojson(coll.getIndexes()));
                helpers.assertHealthyMultikeyQueries(coll, base);
                ++stats.checkpointChecks;
            }

            assert.commandWorked(workerDB.runCommand({ping: 1}));
            assert.eq(true, coll.drop());
            ++stats.collectionDrops;
            assert.commandWorked(workerDB.dropDatabase());
            ++stats.databaseDrops;

            if ((round + 1) % 50 === 0) {
                print("multikey catalog stress worker=" + workerId + " rounds=" + (round + 1));
            }
        }

        return stats;
    }

    const startedMillis = Date.now();
    const threads = [];
    for (let workerId = 0; workerId < workerCount; ++workerId) {
        const thread = new ScopedThread(
            stressWorker, helpers, host, dbPrefix, workerId, iterations, checkpointEvery);
        threads.push(thread);
        thread.start();
    }

    const totals = {
        workers: workerCount,
        iterationsPerWorker: iterations,
        totalIterations: workerCount * iterations
    };
    helpers.counterNames.forEach(function(counterName) {
        totals[counterName] = 0;
    });

    threads.forEach(function(thread) {
        thread.join();
        const stats = thread.returnData();
        assert.neq(undefined, stats, "stress worker did not return results");
        helpers.counterNames.forEach(function(counterName) {
            totals[counterName] += stats[counterName];
        });
    });

    const canaryDB = db.getSiblingDB(canaryDBName);
    createCanary(canaryDB);
    if (!keepCanary) {
        assert.eq(true, canaryDB.canary.drop());
        assert.commandWorked(canaryDB.dropDatabase());
    }

    assert.commandWorked(db.adminCommand({ping: 1}));
    totals.keepCanary = keepCanary;
    totals.canaryDB = canaryDBName;
    totals.elapsedMillis = Date.now() - startedMillis;
    print("MULTIKEY_CATALOG_COMMIT_STRESS_OK " + tojsononeline(totals));
})();
