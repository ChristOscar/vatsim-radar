import type { VatsimPilot, VatsimPilotFlightPlan } from '~/types/data/vatsim';
import { influxDB } from '~/utils/backend/influx/influx';

export type InfluxFlight = {
    [K in keyof Pick<VatsimPilot, 'altitude' | 'callsign' | 'cid' | 'groundspeed' | 'heading' | 'latitude' | 'longitude' | 'name' | 'qnh_mb' | 'transponder'>]?: VatsimPilot[K] | null
} & {
    [K in keyof Pick<VatsimPilotFlightPlan, 'aircraft_short' | 'altitude' | 'arrival' | 'departure' | 'enroute_time' | 'flight_rules' | 'route'> as `fpl_${ K }`]?: VatsimPilotFlightPlan[K] | null
} & {
    _time: string;
    time?: number;
    cid: string;
    disconnected?: boolean | null;
};
const flightKeys = Object.keys({
    _time: true,
    fpl_aircraft_short: true,
    altitude: true,
    fpl_arrival: true,
    fpl_altitude: true,
    callsign: true,
    cid: true,
    fpl_departure: true,
    disconnected: true,
    fpl_enroute_time: true,
    fpl_flight_rules: true,
    groundspeed: true,
    heading: true,
    latitude: true,
    longitude: true,
    name: true,
    qnh_mb: true,
    fpl_route: true,
    time: true,
    transponder: true,
} satisfies Record<keyof InfluxFlight, true>) as Array<keyof InfluxFlight>;

async function getFlightRows(query: string) {
    return (await influxDB.collectRows<InfluxFlight>(query))
        .map(x => ({
            ...x,
            time: new Date(x._time).getTime(),
        }) satisfies InfluxFlight)
        .sort((a, b) => b.time - a.time);
}

export function filterRows(rows: InfluxFlight[]): InfluxFlight[] {
    return rows.filter((row, index) => {
        const nextRow = rows[index + 1];
        if (!row?.heading || !row.name || !row.qnh_mb || !row.transponder || !row.fpl_arrival || (!row.groundspeed && row.fpl_arrival && (!row.altitude || row.altitude < 3000))) return true;

        const similarRow = (
            row.fpl_arrival && nextRow?.fpl_arrival === row.fpl_arrival && nextRow?.fpl_departure === row.fpl_departure && row.fpl_enroute_time === nextRow.fpl_enroute_time && row.callsign === nextRow.callsign
        ) || (!nextRow?.fpl_arrival && nextRow?.name === row.name && nextRow?.callsign === row.callsign)
            ? rows[index + 1]
            : null;
        return !similarRow;
    });
}

export async function getInfluxFlightsForCid({
    cid,
    limit,
    startDate,
    endDate,
}: {
    cid: string;
    limit: number;
    startDate: number;
    endDate?: number;
    offset?: number;
    onlineOnly?: boolean;
}) {
    const fluxQuery =
        `import "influxdata/influxdb/schema" import "strings" from(bucket: "${ process.env.INFLUX_BUCKET_PLANS }")
  |> range(start: ${ Math.round(startDate / 1000) }, stop: ${ endDate ? Math.round(endDate / 1000) : 'now()' })
  |> filter(fn: (r) => r["_measurement"] == "data")
  |> filter(fn: (r) => r["cid"] == "${ cid }")
  |> schema.fieldsAsCols()
  |> group(columns: ["_time"])`;

    const rows = await getFlightRows(fluxQuery);

    return {
        rows: filterRows(rows).slice(0, limit),
    };
}

export async function getInfluxLatestFlightForCids({
    cids,
    startDate,
    endDate,
}: {
    cids: number[];
    startDate: number;
    endDate?: number;
}) {
    const fluxQuery =
        `import "influxdata/influxdb/schema" import "strings" from(bucket: "${ process.env.INFLUX_BUCKET_PLANS }")
  |> range(start: ${ Math.round(startDate / 1000) }, stop: ${ endDate ? Math.round(endDate / 1000) : 'now()' })
  |> filter(fn: (r) => r["_measurement"] == "data")
  |> filter(fn: (r) => ${ cids.map(x => `r["cid"] == "${ x }"`).join(' or ') })
  |> schema.fieldsAsCols()
  |> group(columns: ["_time"])`;

    const rows = await getFlightRows(fluxQuery);

    const pilots: {
        cid: number;
        row: InfluxFlight | undefined;
    }[] = [];

    for (const row of rows) {
        if (pilots.some(x => x.cid === +row.cid!) || !row.cid) continue;

        const foundRow = filterRows(rows.filter(x => x.cid === row.cid))[0];
        pilots.push({
            cid: +row.cid!,
            row: foundRow,
        });
    }

    return pilots.filter(x => x.row);
}

export async function getInfluxOnlineFlightTurns(cid: string) {
    const { rows: [row] } = await getInfluxFlightsForCid({
        cid,
        limit: 1,
        onlineOnly: true,
        startDate: new Date().getTime() - (1000 * 60 * 60 * 24),
    });

    if (!row) return null;

    const fluxQuery =
        `import "influxdata/influxdb/schema" import "strings" from(bucket: "${ process.env.INFLUX_BUCKET_MAIN }")
  |> range(start: ${ row._time })
  |> filter(fn: (r) => r["_measurement"] == "data")
  |> filter(fn: (r) => r["cid"] == "${ cid }")
  |> schema.fieldsAsCols()
  |> keep(columns: ["_time", "cid", "altitude", "latitude", "longitude", "groundspeed"])
  |> group(columns: ["_time"])`;

    const rows = await getFlightRows(fluxQuery);

    return rows.reverse().map((row, index) => {
        for (const key of flightKeys) {
            if (!row[key] && rows[index - 1]?.[key]) {
                // @ts-expect-error Restoring data from prev entry
                row[key] = rows[index - 1]?.[key];
            }
        }

        return row;
    }).reverse();
}

export async function getInfluxOnlineFlightsTurns(cids: number[]) {
    const flights = await getInfluxLatestFlightForCids({
        cids,
        startDate: new Date().getTime() - (1000 * 60 * 60 * 24),
    });

    if (!flights.length) return null;

    const fluxQuery =
        `import "influxdata/influxdb/schema" import "strings" from(bucket: "${ process.env.INFLUX_BUCKET_MAIN }")
  |> range(start: ${ flights.sort((a, b) => a.row!.time! - b.row!.time!)[0].row!._time }, stop: -5s)
  |> filter(fn: (r) => r["_measurement"] == "data")
  |> filter(fn: (r) => ${ flights.map(x => `r["cid"] == "${ x.cid }"`).join(' or ') })
  |> schema.fieldsAsCols()
  |> keep(columns: ["_time", "cid", "altitude", "latitude", "longitude", "groundspeed"])
  |> group(columns: ["_time"])`;

    console.time('turns');

    const rows = await getFlightRows(fluxQuery);

    console.timeEnd('turns');

    const pilots: {
        cid: number;
        rows: InfluxFlight[];
    }[] = [];

    for (const row of rows) {
        if (pilots.some(x => x.cid === +row.cid!) || !row.cid) continue;

        const flight = flights.find(x => x.cid === +row.cid!);
        if (!flight || row.time < flight.row!.time!) continue;

        const foundRows = rows.filter(x => x.cid === row.cid);

        pilots.push({
            cid: +row.cid!,
            rows: foundRows.reverse().map((row, index) => {
                for (const key of flightKeys) {
                    if (!row[key] && foundRows[index - 1]?.[key]) {
                        // @ts-expect-error Restoring data from prev entry
                        row[key] = foundRows[index - 1]?.[key];
                    }
                }

                return row;
            }).reverse(),
        });
    }

    return pilots;
}