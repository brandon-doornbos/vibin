function random(low: number = 0, high: number = 0) {
    if (high) {
        return Math.random() * (high - low) + low;
    } else if (low) {
        return Math.random() * low;
    } else {
        return Math.random();
    }
}

function random_int(low: number = 0, high: number = 0) {
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

export function shuffle(array: any[]) {
    for (let i = array.length - 1; i >= 0; i--) {
        const j = random_int(i + 1);
        const temp = array[i];
        array[i] = array[j];
        array[j] = temp;
    }
}

export function string_to_index(s: string, queue_len: number) {
    let num = undefined;
    if (s === "last") {
        num = queue_len - 1;
    } else {
        num = parseInt(s) - 1;
    }
    return num;
}
