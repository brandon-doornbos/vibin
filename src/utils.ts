function random(low = 0, high = 0) {
    if (high)
        return Math.random() * (high - low) + low;
    else if (low)
        return Math.random() * low;
    else
        return Math.random();
}

function random_int(low = 0, high = 0) {
    return Math.floor(random(low, high));
}

export function seconds_to_hms(d: number) {
    const h = Math.floor(d / 3600);
    const m = Math.floor(d % 3600 / 60);
    const s = Math.floor(d % 3600 % 60);

    const hDisplay = (h > 0 ? (h < 10 ? "0" : "") + h : "00") + ":";
    const mDisplay = (m > 0 ? (m < 10 ? "0" : "") + m : "00") + ":";
    const sDisplay = s > 0 ? (s < 10 ? "0" : "") + s : "00";

    return hDisplay + mDisplay + sDisplay;
}

export function hms_to_seconds(hms: string) {
    if (!hms)
        return 0;

    const parts = hms.split(":").reverse();
    let total_seconds = 0;

    if (parts[2]) {
        const hours = parseInt(parts[2]);
        total_seconds += 3600 * Math.max(0, isNaN(hours) ? 0 : hours);
    }
    if (parts[1]) {
        const minutes = parseInt(parts[1]);
        total_seconds += 60 * Math.max(0, isNaN(minutes) ? 0 : minutes);
    }
    if (parts[0]) {
        const seconds = parseInt(parts[0]);
        total_seconds += Math.max(0, isNaN(seconds) ? 0 : seconds);
    }

    return total_seconds;
}

export function shuffle(array: unknown[]) {
    for (let i = array.length - 1; i >= 0; i--) {
        const j = random_int(i + 1);
        const temp = array[i];
        array[i] = array[j];
        array[j] = temp;
    }
}

export function string_to_index(s: string, queue_len: number) {
    let num: undefined | number = undefined;

    if (s === "last")
        num = queue_len - 1;
    else
        num = parseInt(s) - 1;

    return num;
}
