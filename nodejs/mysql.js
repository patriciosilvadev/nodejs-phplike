var socket = require('./socket.js');
var packetReader = require('./mysql/packetReader.js');
var packetWriter = require('./mysql/packetWriter.js');
var packet = require('./mysql/packet.js');
var encrypt = require('./mysql/encrypt.js');

var commandFlags = require('./mysql/commandFlags.js');
var clientFlags = require('./mysql/clientFlags.js');
//var hexdump = require('hexdump-nodejs');

var serverInfo;

function mysqli_connect(host, user, password, dbName, port) {//{{{
    var isBinary = true;
    serverInfo = [];
    var session = socket.fsockopen(host, port);
    var res = socket.fread(session, 4);
    var reader = new packetReader(res);
    var resLength = reader.readInteger(3);

    res = socket.fread(session, resLength, isBinary);
    reader = new packetReader(res);
    serverInfo['session'] = session;
    serverInfo['procotolVersion'] = reader.readInteger(1);
    serverInfo['version'] = reader.readString();
    serverInfo['connectId'] = reader.readInteger(4);
    serverInfo['authPluginDataPart1'] = reader.readString(8);
    reader.passBytes(1);
    serverInfo['capabilityFlag1'] = reader.readInteger(2);
    serverInfo['characterSet'] = reader.readInteger(1);
    serverInfo['statusFlag'] = reader.readInteger(2);
    serverInfo['protocol41'] = (serverInfo['capabilityFlag1'] & (1 << 9)) > 0

    if (serverInfo['protocol41']) {
        serverInfo['capabilityFlag2'] = reader.readInteger(2);
        serverInfo['scrambleLength']  = reader.readInteger(1);
        reader.passBytes(10);
        serverInfo['authPluginDataPart2']  = reader.readString(12);
        reader.passBytes(1);
    } else {
        reader.passBytes(13);
    }

    //console.log(serverInfo);var b = new Buffer(res, 'binary');console.log(hexdump(b));return res;
    if (user) {
        var resInfo = {};
        mysql_login(serverInfo, user, password, dbName);

        res = readMsg(serverInfo['session']);
        reader = new packetReader(res);
        resInfo['header'] = reader.readInteger(1);

        //var b = new Buffer(res, 'binary');console.log(hexdump(b));
        if (resInfo['header'] === 0 ) {
            //Successfully login 
            resInfo['affectedRows'] = reader.readLengthEncodedInteger();
            resInfo['lastInsertId'] = reader.readLengthEncodedInteger();
            resInfo['statusFlag'] = reader.readInteger(2);
        } else if (resInfo['header'] === 0xFF) {
            // Error
            resInfo = packet.readError(serverInfo, reader);            
            //console.log(resInfo);
            var err = new Error("Error[" +resInfo['errorCode']+"]:" + resInfo['errorMessage']);
            throw err;
        }


 
    }

    return serverInfo;
}//}}}

function mysql_connect(server, user, password) {//{{{
    var s, host, port = 3306, dbName = "";
    s = server.split(/:/);
    host = s[0];
    if (s[1]) port = s[1];
    return mysqli_connect(host, user, password, dbName, port);
};//}}}

function mysql_close(ser) {//{{{
    var w, session;
    w = new packetWriter();
    w.writeInteger(1, commandFlags.COM_PROCESS_KILL);
    if (ser) {
        session = ser['session'];
        w.writeInteger(4, ser['connectId']); 
    } else {
        session = serverInfo['session'];
        w.writeInteger(4, serverInfo['connectId']);
    }
    socket.sendcmd(w.getResult(), session); 

    if (ser) ser = null;
    else serverInfo = null;
}//}}}

function mysql_login(serverInfo, user, password, dbName) {//{{{
    var flags, buffer, maxPacketSize = 1, characterSet, scrambleBuff = "vseeeefgesgtset", authData, authKey;
    characterSet = 33;
    flags = 455631;//clientFlags.CLIENT_PLUGIN_AUTH;

    if (serverInfo['protocol41'] === true) {

        writer = new packetWriter();
        writer.writeInteger(4, flags);
        writer.writeInteger(4, 0x01 << 24);//maxPacketSize);
        writer.writeInteger(1, characterSet);
        writer.writeFills(23);
        writer.writeStringWithNull(user);

        //https://dev.mysql.com/doc/internals/en/secure-password-authentication.html#packet-Authentication::Native41
        //SHA1( password ) XOR SHA1( "20-bytes random data from server" <concat> SHA1( SHA1( password ) ) ) 

        authKey =  new Buffer(serverInfo['authPluginDataPart1'].length + serverInfo['authPluginDataPart2'].length);

        authKey.write(serverInfo['authPluginDataPart1'], 0 ,'binary');
        authKey.write(serverInfo['authPluginDataPart2'], serverInfo['authPluginDataPart1'].length, 'binary');

        authData = encrypt.encryptPassword(password, authKey);
        var length = authData.length;
        writer.writeInteger(1, length); //if length < 251
        writer.writeBuffer(authData);
        writer.writeStringWithNull(dbName);
    } else {
        writer = new packetWriter();
        writer.writeInteger(2, flags);
        writer.writeInteger(3, maxPacketSize);

    }
    var result = writer.getResult(1);
    //console.log(hexdump(result));

    socket.sendcmd(result, serverInfo['session']);
}//}}}

// https://dev.mysql.com/doc/internals/en/com-query.html
function mysql_query(sql, ser) {//{{{
    var i, n, j;
    var data, result, writer, resInfo = [], res, header, fieldName, val, ser;
    var resFields = [], dataRows = []; //return

    if (!ser) {
        ser = serverInfo;
    }

    if (!ser || !ser['session']) {
        throw  new Error("Mysql session is closed.");
    }

    writer = new packetWriter();
    writer.writeInteger(1, 3);
    writer.writeString(sql);
    result = writer.getResult(0);
    //var b = new Buffer(result, 'binary');console.log(hexdump(b));

    socket.sendcmd(result, ser['session']);


    res = readMsg(ser['session']);
    reader = new packetReader(res);
    resInfo['header'] = reader.readInteger(1);

    if (resInfo['header'] === 0xFF) {
        // Error
        resInfo = packet.readError(ser, reader);            
        var err = new Error("Error[" +resInfo['errorCode']+"]:" + resInfo['errorMessage']);
        throw err;
    }


    //ColumnDefinition handle 
    while(1) {
        res = readMsg(ser['session']);
        var reader = new packetReader(res);
        if (packet.isColumnDef(ser, reader)) {
            var columnDef = packet.readColumnDefinition(ser, reader);
            //console.log(columnDef);
            //b = new Buffer(res, 'binary');console.log(hexdump(b));
            resFields.push(columnDef['name']);
        } else if (packet.isEof(ser, reader)) {
            //b = new Buffer(res, 'binary');console.log(hexdump(b));
            if (!resFields || !resFields.length) {
                continue;

            }
            break;
        }
    }

    i = 0;
    while(1) {
        if (!dataRows[i]) dataRows[i] = {};

        res = readMsg(ser['session']);
        reader = new packetReader(res);
        //b = new Buffer(res, 'binary');console.log(hexdump(b));
        header = reader.readInteger(1);
        reader.index--;
        if (header === 0xFE) {
            return dataRows;
        }

        data = reader.readFieldsValue();
        for (j in data) {
            dataRows[i][resFields[j]] = data[j];
        }
        i++;
    }

    return dataRows;
}//}}}

function mysql_select_db(dbName, ser) {//{{{
    var w, result, reader, res, ser;
    if (!dbName) return "";
    if (!ser) {
        ser = serverInfo;
    }
    w = new packetWriter();
    w.writeInteger(1, commandFlags.COM_INIT_DB)
    w.writeString(dbName);
    result = w.getResult();
    socket.sendcmd(result, ser['session']);

    res = readMsg(ser['session']);
    reader = new packetReader(res);
    if (reader.readInteger(1) === 0xFF) {
        var resInfo = packet.readError(ser, reader);            
        var err = new Error("Error[" +resInfo['errorCode']+"]:" + resInfo['errorMessage']);
        throw err;
    }

};//}}}

function readMsg(session) {//{{{
    var reder, res, resLength;
    // Read length;
    res = socket.fread(session, 4);
    reader = new packetReader(res);
    resLength = reader.readInteger(3);

    // Read string
    res = socket.fread(session, resLength, true);
    reader = new packetReader(res);

    return res;
}//}}}



/*******/

exports.mysqli_connect = mysqli_connect;

exports.mysql_connect = mysql_connect;
exports.mysql_query = mysql_query;
exports.mysql_select_db = mysql_select_db;
exports.mysql_close = mysql_close;

