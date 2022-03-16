function random(low, high) {
    if(high !== undefined) {
        return Math.random() * (high-low) + low; 
    } else if(low !== undefined) {
        return Math.random() * low;
    } else {
        return Math.random();
    }
}

function randomInt(low, high) {
    return Math.floor(random(low, high));
}

export function shuffle(array) {
    for(let i = array.length - 1; i >= 0; i--) {
        const j = randomInt(i+1);
        const temp = array[i];
        array[i] = array[j];
        array[j] = temp;
    }
}

export function stringToIndex(s, queueLen) {
    let num;
    if (s === "last") {
        num = queueLen - 1;
    } else {
        num = parseInt(s) - 1;
    }
    return num;
}

export function secondsToHms(d) {
    d = Number(d);
    var h = Math.floor(d / 3600);
    var m = Math.floor(d % 3600 / 60);
    var s = Math.floor(d % 3600 % 60);

    var hDisplay = (h > 0 ? (h < 10 ? "0" : "") + h : "00") + ":";
    var mDisplay = (m > 0 ? (m < 10 ? "0" : "") + m : "00") + ":";
    var sDisplay = s > 0 ? (s < 10 ? "0" : "") + s : "00";
    return hDisplay + mDisplay + sDisplay; 
}
