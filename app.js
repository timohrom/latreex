var express = require('express');
var logger = require('morgan');
var bodyParser = require('body-parser');
var errorHandler = require('errorhandler');
var stylus = require('stylus');

var ejs = require('ejs');
var execFile = require('child_process').execFile;
var fs = require('fs');
var uuid = require('node-uuid');

var config = require('./config');
var latexTemplate = fs.readFileSync(__dirname + '/lib/latex.ejs', 'utf8');
var noto = require('./lib/noto');
var script = require('./lib/script');
var treeDir = config.treeDir || __dirname + '/trees';

var fontMap = {
    noto_sans:  'Noto Sans',
    noto_serif: 'Noto Serif',
    noto_mono:  'Noto Mono',
    arial:      'Arial',
    times:      'Times New Roman',
    courier:    'Courier New'
};

if (!fs.existsSync(treeDir)) fs.mkdirSync(treeDir);

var app = express();

app.set('views', __dirname + '/views');
app.set('view engine', 'jade');
app.use(logger('dev'));
app.use(bodyParser.urlencoded({ extended: false }));

app.use(stylus.middleware({
    compile: function(str, path) {
        return stylus(str)
            .set('filename', path)
            .set('include css', true)
            .set('compress', true)
    },
    src: __dirname + '/public'
}));

app.use(express.static(__dirname + '/public'));

if (app.get('env') === 'development')
  app.use(errorHandler({ dumpExceptions: true, showStack: true }));

config.basepath = config.basepath || '/';
app.locals.basepath = config.basepath;

app.get('/', index);
app.post('/tex', makeLatex, returnInfo);
app.post('/pdf', makeLatex, makeFile('pdf'), returnInfo);
app.post('/png', makeLatex, makeFile('png'), returnInfo);
app.get('/tex/:id/:name', getFile('tex','text/plain'));
app.get('/pdf/:id/:name', getFile('pdf','application/pdf'));
app.get('/png/:id', getFile('png','image/png'));

var proxyApp;

if (config.basepath !== '/') {
    proxyApp = express();
    proxyApp.use(config.basepath, app);
}
else proxyApp = app;

config.port = config.port || 3001;
proxyApp.listen(config.port, function () {
    console.log("Express server listening on port %d in %s mode", config.port, app.settings.env);
});

var paramDefaults = {
    linewidth:  '0.3pt',
    treesep:    '4ex',
    levelsep:   '2cm',
    LFTwidth:   '15ex',
    LFTsep:     '4pt',
    orient:     'D',
    font:       'noto_sans',
    cjk:        'SC',
    style:      'nonflat'
};

var paramValidate = {
    orient: /^(?:D|U|R|L)$/,
    font:   /^(?:noto_(?:sans|serif|mono)|latex_(?:gfs(?:didot|porson)|times_(?:sf|rm|tt))|arial|times|courier)$/,
    cjk:    /^(?:SC|TC|JP|KR)$/,
    style:  /^(?:flat|nonflat)$/
};

['linewidth','treesep','levelsep','LFTwidth','LFTsep'].forEach(function (p) {
    paramValidate[p] = /^(?:[0-9]+)?\.?[0-9]+(?:in|mm|cm|pt|em|ex|pc|bp|dd|cc|sp)$/;
});

var orientToRefpoint = {
    D: 't',
    R: 'l',
    L: 'r',
    U: 'b'
};

function index(req, res, next) {
    res.render('index');
}

function makeLatex(req, res, next) {
    var p = req.body;

    for (var i in p) p[i] = p[i].trim();
    for (var i in paramValidate) {
        if (p[i] !== undefined && !p[i].match(paramValidate[i])) delete p[i];
    }
    for (var i in paramDefaults) {
        if (p[i] === undefined) p[i] = paramDefaults[i];
    }

    p.json = JSON.stringify(p, Object.keys(p).sort());

    var captures = p.font.match(/^latex_([a-z]+)(?:_([a-z]+))?$/);
    if (captures) {
        p.latex = captures[1];
        p.font = captures[2];
    }
    else {
        p.font = fontMap[p.font];
        p.latex = false;
    }

    p.refpoint = orientToRefpoint[p.orient];
    p.tree = parseTree(p.tree.split(/\r\n/))[0];
    p.pstTree = function() { return pstNode(p, p.tree, 0).replace(/^\n/,'') };
    p.roman = function(dec) { return roman(dec).toLowerCase() };

    req.file = uuid.v4();
    req.treeName = getTreeName(p.tree.value);

    fs.writeFile(treeDir+'/'+req.file+'.tex', ejs.render(latexTemplate, p), 'utf8', next);
}

function returnInfo(req, res, next) {
    res.json({ id: req.file, name: req.treeName });
}

function makeFile(ext) {
    return function(req, res, next) {
        execFile(__dirname + '/script/make'+ext+'.sh', [treeDir,req.file], function (code) {
            if (code) return res.sendStatus(409);
            next();
        });
    }
}

function getFile(ext, mime) {
    return function(req, res, next) {
        var id = req.params.id;
        if (!id) return res.sendStatus(409);
        fs.readFile(treeDir+'/'+id+'.'+ext, function (err, data) {
           if (err) return res.sendStatus(409);
           res.attachment();
           res.contentType(mime);
           res.send(data);
        });
    }
}

function parseTree(lines, lineNum, depth) {
    var tree = [];
    lineNum = lineNum || 0;

    for (var i = lineNum, l = lines.length; i < l; i++) {
        var captures = lines[i].match(/^(-*)\s*(.+)$/);
        if (!captures) continue; // blank or malformed line

        var newDepth = captures[1].length;
        if (depth === undefined) depth = newDepth; // set starting depth if we weren't given one

        if (newDepth < depth) break;
        else if (newDepth === depth) tree.push({ value: captures[2], children: [], height: 1 });
        else {
            var subtree = parseTree(lines, i, newDepth);
            var lastNode = tree[tree.length - 1];
            lastNode.children = subtree;
            lastNode.height = Math.max.apply(Math, subtree.map(function (node) { return node.height })) + 1;
            i += subtree.numLines - 1;
        }
    }

    tree.numLines = i - lineNum;
    return tree;
}

function pstNode(p, treeNode, depth) {
    var str = '';
    var node, afternode;
    var captures = treeNode.value.match(/^(\.?)(.*?)(~?)(\^*)$/);

    if (captures[1] !== '' || captures[2] === '') {
        node = '\\Tn';
        afternode = '\\Tp';
    } else {
        node = (captures[3] !== '' ? '\\LFTr' : '\\LFTw')
            + '{'+p.refpoint+'}{'+nodeLabel(captures[2], p)+'}';
        afternode = '\\Tp[edge=none]';
    }

    str += '\n';
    var i = depth;
    while (i--) str += '  ';

    var skip = 0;
    if (p.style === 'flat') {
        skip = p.tree.height - depth - treeNode.height;
        if (captures[4]) skip -= captures[4].length;
        if (skip < 0) skip = 0;
    }

    if (skip > 0) str += '\\skiplevels{'+skip*2+'} ';

    if (treeNode.children.length) {
        str += '\\pstree{'+node+'}{\\pstree{'+afternode+'}{%';
        treeNode.children.forEach(function (x) { str += pstNode(p, x, depth+skip+1) });
        str += '}}';
    }
    else str += node;

    if (skip > 0) str += ' \\endskiplevels';

    return str;
}

function nodeLabel(txt, p) {
    if (p.font && p.font.match(/^Noto/)) {
        var str = '';
        var lastFont;

        script.split(txt).forEach(function (chunk) {
            var substituteFont;
            if (noto[p.font] && noto[p.font][chunk[1]]) substituteFont = noto[p.font][chunk[1]];
            else substituteFont = noto.general[chunk[1]];

            var font = substituteFont || p.font;

            if (font !== lastFont) {
                str += '\\setmainfont{'+font;
                if (font.match(/CJK$/)) str += ' ' + p.cjk;
                str += '}';

                lastFont = font;
            }

            str += escapeLatex(txt);
        });

        return str;
    }
    else return escapeLatex(txt);
}

function escapeLatex(txt) {
    return txt
        .replace(/\\/g,'\\textbackslash{}')
        .replace(/~/g,'\\textasciitilde{}')
        .replace(/[&$%#]/g,'\\$1')
        .replace(/\*([^*]+)\*/g, '\\textbf{$1}')
        .replace(/_([^_]+)_/g, '\\textit{$1}');
}

function getTreeName(txt) {
    txt = txt
        .replace(/~?\^*$/,'')
        .replace(/^\./,'')
        .replace(/[:\\\/]/g,'')
        .trim();

    if (txt === '') txt = 'tree-unnamed';

    return txt;
}

var D = [1,5,10,50,100,500,1000];
var R = ['I','V','X','L','C','D','M'];

function roman(dec) {
  var r = '', d = dec;
  for (var i = 6; i >= 0; i--) {
    while (d >= D[i]) {d -= D[i]; r += R[i];}
    if (i > 0 && d >= D[i]-D[i-2+i%2]) {d -= D[i]-D[i-2+i%2]; r += R[i-2+i%2]+R[i];}
  }
  return r;
}
