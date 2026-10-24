<?php

use Illuminate\Support\Facades\Route;
use App\Http\Controllers\SmokeController;
use Outside\OutsideController;

Route::get('/smoke', function ($request) {
    if (!$user) {
        abort(404);
        return
            rs;
    }

    return response()->json(['ok' => true]);
});

Route::post('/accepted', fn () => response()->json([], 202));
Route::get('/bare-completion', function () {
    rs;
});

Route::get('/controller/{id}', [SmokeController::class, 'show']);
Route::get('/outside-controller/{id}', [OutsideController::class, 'show']);
